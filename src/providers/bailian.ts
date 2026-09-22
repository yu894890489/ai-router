import type { ProviderConfig } from '../config.js';
import { createAnthropicProvider, type Provider } from './base.js';

export const createBailianProvider = (cfg: ProviderConfig): Provider =>
  createAnthropicProvider('bailian', cfg);
