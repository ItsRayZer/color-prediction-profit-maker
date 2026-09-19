import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    proxy: {
      '/api-wingo': {
        target: 'https://draw.ar-lottery01.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api-wingo/, ''),
        secure: false
      }
    }
  }
})
