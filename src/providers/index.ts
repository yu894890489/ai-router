import type { ProviderConfig, RouterConfig } from '../config.js';
import { createAnthropicProvider, type Provider } from './base.js';
import { createBailianProvider } from './bailian.js';
import { createKimiProvider } from './kimi.js';
import { createVolcengineProvider } from './volcengine.js';

export { createKimiProvider, createVolcengineProvider, createBailianProvider };

const factories: Record<string, (cfg: ProviderConfig) => Provider> = {
  kimi: createKimiProvider,
  volcengine: createVolcengineProvider,
  bailian: createBailianProvider,
};

export function createProviders(config: RouterConfig): Map<string, Provider> {
  const map = new Map<string, Provider>();
  for (const [name, cfg] of Object.entries(config.providers)) {
    const factory = factories[name] ?? ((c: ProviderConfig) => createAnthropicProvider(name, c));
    map.set(name, factory(cfg));
  }
  return map;
}
