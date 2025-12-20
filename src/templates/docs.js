export const generateReadme = (title, url) => `
# ${title}

Converted from WebSim: ${url}

## Quick Start

1. **Setup**: Install dependencies and register the app.
   \`\`\`bash
   npm run setup
   \`\`\`
   *Note: Requires Node.js and the Devvit CLI (\`npm i -g devvit\`).*

2. **Run**: Start the emulator.
   \`\`\`bash
   npm run dev
   \`\`\`
   *Access the emulator at http://localhost:5173 (or as indicated in terminal).*

## How it Works

- **Webroot**: The \`webroot/\` directory contains the game files. These are served inside a webview in the Reddit app.
- **Logging**: Console logs from the game are piped to your terminal. Look for lines starting with \`[Web]\`.
- **Validation**: The \`npm run setup\` command runs \`scripts/validate.js\` to check for common issues (CSP violations, missing files).

## Troubleshooting

- **"App doesn't exist"**: Run \`npx devvit upload\` manually.
- **"Invalid token/syntax"**: Ensure your Node version is up to date (v18+).
- **White Screen/Loading Forever**: Check the terminal for JS errors.
  - If you see "Content Security Policy" warnings, some external resources might be blocked by Reddit's strict security rules.
  - Verify \`webroot/index.html\` exists and has content.

## Modifications

To modify the game, edit files in \`webroot/\`.
To modify the Reddit app wrapper, edit \`src/main.tsx\`.

## Feedback & Debugging

If you encounter bugs, please include the full logs from the terminal in your report.
If the AI needs to investigate specific files, it will ask for them here.
`;

