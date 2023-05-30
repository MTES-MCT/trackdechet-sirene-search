import fs from "fs";
import stream, { Writable } from "stream";
import util from "util";
import {
  BulkOperationContainer,
  BulkOperationType,
  BulkResponse
} from "@elastic/elasticsearch/api/types";
import { ApiResponse } from "@elastic/elasticsearch";
import { parse } from "fast-csv";
import { logger, elasticSearchClient as client } from "..";
import {
  ElasticBulkIndexError,
  ElasticBulkNonFlatPayload,
  ElasticBulkNonFlatPayloadWithNull,
  IndexProcessConfig
} from "./types";
import { INDEX_ALIAS_NAME_SEPARATOR } from "./indexInsee.helpers";

const pipeline = util.promisify(stream.pipeline);
const pjson = require("../../package.json");

// Max size of documents to bulk index, depends on ES JVM memory available
const CHUNK_SIZE: number =
  parseInt(`${process.env.INDEX_CHUNK_SIZE}`, 10) || 10_000;

/**
 * Common index name formatter
 */
const getIndexVersionName = (indexConfig: IndexProcessConfig) =>
  `${indexConfig.alias}${INDEX_ALIAS_NAME_SEPARATOR}${
    pjson.version
  }${INDEX_ALIAS_NAME_SEPARATOR}${Date.now()}`;

/**
 * Create a new index with timestamp appended to the alias name
 * overrides the index alias with a timestamp in order to handle roll-over indices
 */
export const createIndexRelease = async (
  indexConfig: IndexProcessConfig
): Promise<string> => {
  const indexName = getIndexVersionName(indexConfig);
  const { mappings, settings } = indexConfig;
  await client.indices.create({
    index: indexName,
    body: {
      ...(mappings && { mappings }),
      ...{
        settings: {
          // optimize for speed https://www.elastic.co/guide/en/elasticsearch/reference/6.8/tune-for-indexing-speed.html
          refresh_interval: -1,
          number_of_replicas: 0
        }
      },
      ...(settings && { settings })
    },
    include_type_name: true // Compatibility for v7+ with _doc types
  });
  logger.info(`Created a new index ${indexName}`);
  return indexName;
};

/**
 * Clean older indexes and point the production alias on the new index
 * Setup final settings
 */
const finalizeNewIndexRelease = async (
  indexAlias: string,
  indexName: string
) => {
  const aliases = await client.cat.aliases({
    name: indexAlias,
    format: "json"
  });
  const bindedIndexes = aliases.body.map((info: { index: any }) => info.index);
  logger.info(`Setting up final parameters for the index alias ${indexAlias}.`);
  await client.indices.putSettings({
    index: indexName,
    body: {
      index: {
        number_of_replicas: process.env.TD_SIRENE_INDEX_NB_REPLICAS || "3",
        refresh_interval: process.env.TD_SIRENE_INDEX_REFRESH_INTERVAL || "1s"
      }
    }
  });
  logger.info(
    `Pointing the index alias ${indexAlias} to the index ${indexName}.`
  );
  await client.indices.updateAliases({
    body: {
      actions: [
        ...(bindedIndexes.length
          ? [{ remove: { indices: bindedIndexes, alias: indexAlias } }]
          : []),
        { add: { index: indexName, alias: indexAlias } }
      ]
    }
  });
  if (bindedIndexes.length) {
    logger.info(
      `Removed alias pointers to older indices ${bindedIndexes.join(", ")}.`
    );
  }
  // Delete old indices to save disk space, except the last
  const indices = await client.cat.indices({
    index: `${indexAlias}${INDEX_ALIAS_NAME_SEPARATOR}${pjson.version}${INDEX_ALIAS_NAME_SEPARATOR}*`,
    format: "json"
  });
  const oldIndices: string[] = indices.body
    .map((info: { index: string }) => info.index)
    // Filter out the last indexName
    .filter((name: string) => name !== indexName)
    .sort();
  // keep the last index in order to rollback if needed
  oldIndices.pop();
  if (oldIndices.length) {
    logger.info(
      `Removing ${oldIndices.length} old index(es) (${oldIndices.join(", ")})`
    );
    await client.indices.delete({ index: oldIndices.join(",") });
  }
};

/**
 * Log bulkIndex errors and retries in some cases
 */
const logBulkErrorsAndRetry = async (
  indexName: string,
  bulkResponse: BulkResponse,
  body: BulkOperationContainer[]
) => {
  if (bulkResponse.errors) {
    for (let k = 0; k < bulkResponse.items.length; k++) {
      const action = bulkResponse.items[k]!;
      const operations: string[] = Object.keys(action);
      for (const operation of operations) {
        const opType = operation as BulkOperationType;
        if (opType && action[opType]?.error) {
          // If the status is 429 it means that we can retry the document
          if (action[opType]?.status === 429) {
            logger.warn(
              `Retrying index operation for doc ${
                body[k * 2].index?._id
              } in index ${indexName}`
            );
            try {
              await client.index({
                index: indexName,
                id: body[k * 2].index?._id as string,
                body: body[k * 2 + 1],
                type: "_doc",
                refresh: false
              });
            } catch (err) {
              logger.error(
                `Error retrying index operation for doc ${
                  body[k * 2].index?._id
                } in index ${indexName}`,
                err
              );
            }
          }
          // otherwise it's very likely a mapping error, and you should fix the document content
          const elasticBulkIndexError: ElasticBulkIndexError = {
            status: action[opType]?.status ?? 0,
            error: action[opType]?.error,
            body: body[k * 2 + 1]
          };
          logger.error(`Error in bulkIndex operation`, {
            elasticBulkIndexError
          });
        }
      }
    }
  }
};

/**
 * bulkIndex request
 */
const request = async (
  indexName: string,
  indexConfig: IndexProcessConfig,
  bodyChunk: ElasticBulkNonFlatPayload
): Promise<void> => {
  /**
   * Calls client.bulk
   */
  const requestBulkIndex = async (body: BulkOperationContainer[]) => {
    if (!body || !body.length) {
      // nothing to index
      return Promise.resolve();
    }

    try {
      const bulkResponse: ApiResponse<BulkResponse> = await client.bulk({
        body,
        // lighten the response
        _source_excludes: ["items.index._*", "took"]
      });
      // Log error data and continue
      if (bulkResponse) {
        await logBulkErrorsAndRetry(indexName, bulkResponse.body, body);
      }
    } catch (bulkIndexError) {
      // avoid dumping huge errors to the logger
      logger.error(
        `Fatal error bulk-indexing to index ${indexName}: ${bulkIndexError}`,
        bulkIndexError
      );
      return;
    }
  };
  if (bodyChunk.length) {
    logger.info(
      `Indexing ${bodyChunk.length} documents in bulk to index ${indexName}`
    );
  }
  // append new data to the body before indexation
  if (typeof indexConfig.dataFormatterFn === "function") {
    const formattedChunk = await indexConfig.dataFormatterFn(
      bodyChunk,
      indexConfig.dataFormatterExtras
    );
    return requestBulkIndex(formattedChunk.flat() as BulkOperationContainer[]);
  }
  return requestBulkIndex(bodyChunk.flat() as BulkOperationContainer[]);
};

/**
 * Bulk Index and collect errors
 * controls the maximum chunk size because unzip does not
 */
export const bulkIndexByChunks = async (
  body: ElasticBulkNonFlatPayload,
  indexConfig: IndexProcessConfig,
  indexName: string
): Promise<void> => {
  // immediat return the chunk when size is greater than the data streamed
  if (CHUNK_SIZE > body.length) {
    await request(indexName, indexConfig, body);
    return;
  }

  const promises: Promise<void>[] = [];
  // number if chunk requests in-flight
  let numberOfChunkRequests = 0;
  // Default concurrent requests is 2
  const maxConcurrentRequests = isNaN(
    parseInt(process.env.TD_SIRENE_INDEX_MAX_CONCURRENT_REQUESTS || "1", 10)
  )
    ? 2
    : parseInt(process.env.TD_SIRENE_INDEX_MAX_CONCURRENT_REQUESTS || "1", 10);

  // loop over other chunks
  for (let i = 0; i < body.length; i += CHUNK_SIZE) {
    const end = i + CHUNK_SIZE;
    const slice = body.slice(i, end);
    const promise = request(indexName, indexConfig, slice);
    if (maxConcurrentRequests > 1) {
      promises.push(promise);
      numberOfChunkRequests++; // Increment the in-flight counter

      // Check if the maximum number of promises is reached
      if (numberOfChunkRequests >= maxConcurrentRequests) {
        await Promise.race(promises); // Wait for any one of the promises to resolve
        numberOfChunkRequests--; // Decrement the in-flight counter
      }
    } else {
      await request(indexName, indexConfig, slice);
    }
  }
  if (promises.length > 0) {
    await Promise.all(promises);
  }
};

/**
 * Writable stream that parses CSV to an ES bulk body
 */
const getWritableParserAndIndexer = (
  indexConfig: IndexProcessConfig,
  indexName: string
) =>
  new Writable({
    // Increase memory usage for better performance
    // 128 KiB (128*1024=131_072)
    highWaterMark: 131_072,
    objectMode: true,
    writev: (csvLines, next) => {
      const body: ElasticBulkNonFlatPayloadWithNull = csvLines.map(
        (chunk, i) => {
          const doc = chunk.chunk;
          // skip lines without "idKey" column because we cannot miss the _id in ES
          if (
            doc[indexConfig.idKey] === undefined ||
            !doc[indexConfig.idKey].length
          ) {
            logger.error(
              `skipping malformed csv line ${i} missing _id key ${indexConfig.idKey}`,
              doc
            );
            return null;
          } else if (doc[indexConfig.idKey] === indexConfig.idKey) {
            // first line
            return null;
          } else {
            return [
              {
                index: {
                  _id: doc[indexConfig.idKey],
                  _index: indexName,
                  // Next major ES version won't need _type anymore
                  _type: "_doc"
                }
              },
              doc
            ];
          }
        }
      );

      bulkIndexByChunks(
        body.filter(line => line !== null) as ElasticBulkNonFlatPayload,
        indexConfig,
        indexName
      )
        .then(() => next())
        .catch(err => next(err));
    }
  });

/**
 * Stream CSV to index them in bulk
 */
export const streamReadAndIndex = async (
  csvPath: string,
  indexName: string,
  indexConfig: IndexProcessConfig,
  isReleaseIndexation = true
): Promise<string> => {
  const headers = indexConfig.headers;
  const writableStream = getWritableParserAndIndexer(indexConfig, indexName);
  // stop parsing CSV after MAX_ROWS
  const maxRows = parseInt(process.env.MAX_ROWS as string, 10);
  await pipeline(
    fs.createReadStream(csvPath),
    parse({
      headers,
      ignoreEmpty: true,
      discardUnmappedColumns: true,
      ...(maxRows && { maxRows })
    })
      .transform((data, callback) => {
        if (!!indexConfig.transformCsv) {
          indexConfig.transformCsv(data, callback);
        }
      })
      .on("error", error => {
        throw error;
      })
      .on("end", async (rowCount: number) => {
        logger.info(`Finished parsing ${rowCount} CSV rows`);
      }),
    writableStream
  );
  // roll-over index alias
  if (isReleaseIndexation) {
    await finalizeNewIndexRelease(indexConfig.alias, indexName);
  }
  logger.info(`Finished indexing ${indexName} with alias ${indexConfig.alias}`);
  return csvPath;
};
