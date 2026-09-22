import type { ProviderConfig } from '../config.js';
import { createAnthropicProvider, type Provider } from './base.js';

export const createKimiProvider = (cfg: ProviderConfig): Provider =>
  createAnthropicProvider('kimi', cfg);
