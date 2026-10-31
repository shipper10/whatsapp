import type { LibraryPort } from "../bot/types.js";
import type { Db } from "../db/client.js";
import {
  albumMessageIds,
  childNodes,
  indexMessage,
  indexTitles,
  messageKinds,
  nodeInfo,
  recentResources,
  resourceDetail,
  resourcesInNode,
  rootIndexId,
  telegramMessageDetail,
} from "./browse.js";
import { matchIndexes } from "./indexSearch.js";
import { searchResources } from "./search.js";

export class DbLibrary implements LibraryPort {
  constructor(private readonly db: Db) {}
  children = (parentId: number | null) => childNodes(this.db, parentId);
  node = (id: number) => nodeInfo(this.db, id);
  resources = (nodeId: number, limit: number, offset: number) =>
    resourcesInNode(this.db, nodeId, { limit, offset });
  search = (query: string, limit: number, offset: number) =>
    searchResources(this.db, query, { limit, offset });
  recent = (limit: number, offset: number) => recentResources(this.db, { limit, offset });
  detail = (id: number) => resourceDetail(this.db, id);
  indexMessage = (messageId: number) => indexMessage(this.db, messageId);
  rootIndexId = () => rootIndexId(this.db);
  findIndexes = async (query: string, limit: number) =>
    matchIndexes(await indexTitles(this.db), query, limit);
  messageKinds = (ids: number[]) => messageKinds(this.db, ids);
  messageDetail = (messageId: number) => telegramMessageDetail(this.db, messageId);
  albumMessageIds = (messageId: number) => albumMessageIds(this.db, messageId);
}
