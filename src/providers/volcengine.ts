import type { ProviderConfig } from '../config.js';
import { createAnthropicProvider, type Provider } from './base.js';

export const createVolcengineProvider = (cfg: ProviderConfig): Provider =>
  createAnthropicProvider('volcengine', cfg);
