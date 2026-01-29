import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5200,
    proxy: {
      '/socket.io': {
        target: 'http://localhost:3010',
        ws: true,
      },
      '/api': {
        target: 'http://localhost:3010',
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});
