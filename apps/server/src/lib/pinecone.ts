import { Pinecone, type Index } from '@pinecone-database/pinecone';

import { env, features } from '../config/env.js';
import { ServiceUnavailableError } from './errors.js';

let _client: Pinecone | null = null;

export function getPineconeIndex(): Index {
  if (!features.rag) throw new ServiceUnavailableError('Pinecone');
  if (!_client) _client = new Pinecone({ apiKey: env.PINECONE_API_KEY! });
  return _client.index(env.PINECONE_INDEX);
}
