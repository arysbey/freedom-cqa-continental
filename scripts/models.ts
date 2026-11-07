import { config } from '../server/config.js';
import { GeminiProvider, ProviderError } from '../server/provider.js';

try {
  const models = await new GeminiProvider(config).listModels();
  console.log(JSON.stringify({ status: 'PASS', selectedModel: config.model, selectedModelListed: models.some(model => model.id === config.model), configuredModelMetadata: models.find(model => model.id === config.model) ?? null, catalogModelCount: models.length, eligibleModelIds: models.filter(model => model.freeCatalogEligible).map(model => model.id), note: 'Listing proves model visibility only. Confirm project Free tier and active quotas in Google AI Studio; it does not prove inference availability or billing status.' }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: 'BLOCKED', code: error instanceof ProviderError ? error.code : 'MODEL_LIST_FAILED', message: error instanceof ProviderError ? error.message : 'Could not list Gemini models.' }));
  process.exitCode = 1;
}
