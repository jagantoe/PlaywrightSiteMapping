import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
    // Set by CI to "/<repo>/" for GitHub Pages project sites.
    base: process.env.BASE_PATH ?? '/',
    plugins: [react()],
});
