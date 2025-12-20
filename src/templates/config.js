export const generatePackageJson = (slug, dependencies = {}, devDependencies = {}) => JSON.stringify({
  "name": slug,
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "devvit playtest",
    "build:client": "NODE_ENV=production vite build",
    "setup": "node scripts/setup.js", 
    "register": "devvit upload",
    "upload": "devvit upload",
    "validate": "node scripts/validate.js"
  },
  "dependencies": {
    "@devvit/public-api": "latest",
    "@devvit/kit": "latest",
    "@devvit/web": "latest",
    ...dependencies
  },
  "devDependencies": {
    "devvit": "latest",
    "typescript": "^5.0.0",
    "vite": "^5.0.0",
    "terser": "^5.19.0",
    "@vitejs/plugin-react": "^4.2.0",
    "@babel/core": "^7.23.0",
    "@babel/preset-react": "^7.23.0",
    ...devDependencies
  }
}, null, 2);

export const generateDevvitYaml = (slug) => `name: ${slug}
version: 0.1.0
`;

export const generateViteConfig = ({ hasReact = false, hasRemotion = false } = {}) => `
import { defineConfig } from 'vite';
${hasReact ? "import react from '@vitejs/plugin-react';" : ""}

export default defineConfig({
  mode: 'production',
  root: 'client',
  base: './',
  plugins: [
    ${hasReact ? `react({
      jsxRuntime: 'automatic', 
      // Force production runtime even if code tries to import dev
      jsxImportSource: 'react',
      include: "**/*.{jsx,tsx,js,ts}",
      babel: {
        babelrc: false,
        configFile: false,
        plugins: []
      }
    }),` : ''}
  ],
  resolve: {
    alias: {
      // CRITICAL: Remotion and some React libs might try to import jsx-dev-runtime in 'dev' mode.
      // We alias to a local proxy that implements jsxDEV using the production jsx runtime.
      'react/jsx-dev-runtime': '/jsx-dev-proxy.js',
      'react/jsx-runtime': 'react/jsx-runtime',
      'remotion': 'remotion',
      'websim': '/websim_package.js'
    },
    // Ensure we prioritize browser builds
    mainFields: ['browser', 'module', 'main'],
  },
  assetsInclude: ['**/*.mp3', '**/*.wav', '**/*.ogg', '**/*.glb', '**/*.gltf', '**/*.png', '**/*.jpg', '**/*.jpeg', '**/*.gif'],
  build: {
    outDir: '../webroot',
    emptyOutDir: true,
    target: 'es2020', // Ensure broad compatibility without unsafe polyfills
    minify: 'esbuild', 
    rollupOptions: {
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "[name].js",
        assetFileNames: "[name][extname]",
      },
      // Ensure React is treated as a singleton
      external: [], 
    },
  },
  define: {
    // Hardcode production environment to prevent libs from taking dev paths
    "process.env.NODE_ENV": JSON.stringify("production"),
    "process.platform": JSON.stringify("browser"),
    // Remotion specific flags if needed
    "process.env.REMOTION_ENV": JSON.stringify("production"),
  },
  optimizeDeps: {
    include: [${hasReact ? "'react', 'react-dom', 'react/jsx-runtime'" : ""}, ${hasRemotion ? "'remotion', '@remotion/player'" : ""}]
  }
});
`;

export const tsConfig = JSON.stringify({
  "compilerOptions": {
    "target": "es2020",
    "module": "es2020",
    "moduleResolution": "node",
    "lib": ["es2020", "dom"],
    "jsx": "react",
    "jsxFactory": "Devvit.createElement",
    "jsxFragmentFactory": "Devvit.Fragment",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "noImplicitAny": false
  },
  "include": [
    "src"
  ]
}, null, 2);

