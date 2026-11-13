import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const SERVER = process.env.LOCALKAN_SERVER ?? 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // REST and both WebSockets (/api/ws for this page, /api/bridge for bridges) live under /api.
      '/api': { target: SERVER, ws: true },
    },
  },
});
