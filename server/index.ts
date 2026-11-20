import { loadConfig } from './config.js';
import { FeishuStore } from './feishu.js';
import { createLicenseServer } from './http.js';
import { LicenseService } from './service.js';

try {
  const { feishu, keys, host, port, trustLoopbackProxy } = loadConfig();
  const server = createLicenseServer(new LicenseService(new FeishuStore(feishu), keys), { trustLoopbackProxy });
  server.once('error', () => {
    console.error('Unable to start the license server');
    process.exitCode = 1;
  });
  server.listen(port, host);

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => { server.close(); });
  }
} catch {
  console.error('Invalid license server configuration');
  process.exitCode = 1;
}
