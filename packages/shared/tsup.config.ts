import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    circuit: 'src/circuit.ts',
    catalog: 'src/catalog.ts',
    engine: 'src/engine.ts',
    'ws-protocol': 'src/ws-protocol.ts',
    'worker-protocol': 'src/worker-protocol.ts',
  },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
});
