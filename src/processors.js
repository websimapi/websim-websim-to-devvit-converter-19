import * as acorn from 'https://esm.sh/acorn@8.11.3';
import { simple as walkSimple } from 'https://esm.sh/acorn-walk@8.3.2';
import MagicString from 'https://esm.sh/magic-string@0.30.5';

// Helper: Clean Filename
export const cleanName = (name) => name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

export function uint8ToString(u8) {
  if (typeof u8 === 'string') return u8;
  if (!(u8 instanceof Uint8Array)) return String(u8 ?? '');
  return new TextDecoder().decode(u8);
}

// --- Asset Analyzer & Rewriter (Vite Logic) ---

export class AssetAnalyzer {
    constructor() {
        this.dependencies = {};
    }

    // Detects libraries and converts CDN URLs to NPM package names
    // Returns: Clean import source (e.g., 'three')
    normalizeImport(source) {
        if (!source || typeof source !== 'string') return source;
        if (source.startsWith('.') || source.startsWith('/') || source.startsWith('data:') || source.startsWith('blob:')) return source;

        // 1. Remotion Handling
        if (source.includes('@websim/remotion')) {
            this.dependencies['remotion'] = '^4.0.0';
            this.dependencies['@remotion/player'] = '^4.0.0';
            this.dependencies['react'] = '^18.2.0';
            this.dependencies['react-dom'] = '^18.2.0';
            // Route via bridge to handle mixed exports (Player + hooks)
            return '/remotion_bridge';
        }

        // 2. Three.js Handling
        if (source.includes('/three') || source === 'three') {
            this.dependencies['three'] = '^0.160.0';
            
            // Handle Addons (OrbitControls, GLTFLoader, etc.)
            // Detect "examples/jsm" or "addons"
            if (source.includes('examples/jsm') || source.includes('addons') || source.includes('controls')) {
                // Try to extract the path after 'jsm'
                const match = source.match(/(?:examples\/jsm|addons)\/(.+)/);
                if (match) {
                    let suffix = match[1];
                    // Strip query params if any
                    suffix = suffix.split('?')[0];
                    if (!suffix.endsWith('.js')) suffix += '.js';
                    return `three/examples/jsm/${suffix}`;
                }
            }
            return 'three';
        }

        // 2. Tween.js
        if (source.toLowerCase().includes('tween')) {
            this.dependencies['@tweenjs/tween.js'] = '^23.1.0';
            return '@tweenjs/tween.js';
        }

        // 3. Pixi.js
        if (source.toLowerCase().includes('pixi')) {
            this.dependencies['pixi.js'] = '^7.0.0';
            return 'pixi.js';
        }
        
        // 3.5 React CDN Runtime Fix
        if (source.includes('react')) {
             if (source.includes('jsx-dev-runtime') || source.includes('jsx-runtime')) {
                 this.dependencies['react'] = '^18.2.0';
                 // We preserve the dev-runtime import path so our Vite alias can intercept it with a proxy
                 // Rewriting to jsx-runtime directly breaks code expecting jsxDEV export
                 return source.includes('jsx-dev-runtime') ? 'react/jsx-dev-runtime' : 'react/jsx-runtime';
             }
        }

        // 4. Generic esm.sh / unpkg Handling
        // Capture package name, optional version, AND subpath
        // Updated to handle scoped packages correctly (e.g. @remotion/player)
        const pkgMatch = source.match(/(?:esm\.sh|unpkg\.com|jsdelivr\.net)\/(?:npm\/)?((?:@[^/@]+\/)?[^/@]+)(?:@([^/?]+))?(\/[^?]*)?/);
        if (pkgMatch) {
            const pkg = pkgMatch[1];
            const ver = pkgMatch[2];
            const path = pkgMatch[3] || '';

            // Filter out common non-packages or mistakes
            if (pkg !== 'gh' && pkg !== 'npm') {
                // Update dependency if new or more specific than 'latest'
                const current = this.dependencies[pkg];
                if (!current || (current === 'latest' && ver)) {
                    this.dependencies[pkg] = ver ? `^${ver}` : 'latest';
                }
                // Return package + subpath (e.g. react/jsx-dev-runtime)
                return pkg + path;
            }
        }

        // 5. Bare Specifiers (Import Maps / Node Resolution)
        // If it looks like a package name (no path separators, not a URL), add to dependencies.
        if (!source.match(/^https?:/)) {
            if (source === 'websim') return 'websim'; // Handled by Vite alias, do not add to dependencies

            // Handle scoped packages (@org/pkg) or regular (pkg) potentially followed by /path
            const bareMatch = source.match(/^(@[^/]+\/[^/]+|[^/]+)/);
            if (bareMatch) {
                const pkgName = bareMatch[1];
                
                // Prevent adding scope-only packages (e.g. "@remotion") which cause npm install errors
                if (pkgName.startsWith('@') && !pkgName.includes('/')) {
                    // If it's specifically @remotion, the user might mean 'remotion' package
                    if (pkgName === '@remotion') {
                         if (!this.dependencies['remotion']) this.dependencies['remotion'] = 'latest';
                         return 'remotion';
                    }
                    return source; 
                }

                if (!this.dependencies[pkgName]) {
                    this.dependencies[pkgName] = 'latest';
                }
                return source;
            }
        }
        
        // Return original if we can't map it (Vite might fail, but best effort)
        return source;
    }

    // Rewrites JS imports to use NPM packages
    processJS(jsContent, filename = 'script.js') {
        let code = uint8ToString(jsContent);
        
        // Generic WebSim URL Replacements (Fix CSP issues)
        code = code.replace(/https:\/\/images\.websim\.ai\/avatar\/|https:\/\/images\.websim\.com\/avatar\//g, 'https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png?user=');

        // Calculate relative path to root for asset corrections
        const depth = (filename.match(/\//g) || []).length;
        const rootPrefix = depth > 0 ? '../'.repeat(depth) : './';

        let ast;
        const magic = new MagicString(code);
        let hasChanges = false;

        try {
            ast = acorn.parse(code, { sourceType: 'module', ecmaVersion: 'latest', allowReturnOutsideFunction: true, allowHashBang: true });
            
            const rewrite = (node) => {
                if (node.source && node.source.value) {
                    const newVal = this.normalizeImport(node.source.value);
                    if (newVal !== node.source.value) {
                        magic.overwrite(node.source.start, node.source.end, JSON.stringify(newVal));
                        hasChanges = true;
                    }
                }
            };

            const rewritePaths = (node) => {
                if (node.type === 'Literal' && typeof node.value === 'string') {
                    const val = node.value;
                    if (val.startsWith('/') && !val.startsWith('//') && /\.(png|jpg|jpeg|gif|mp3|wav|ogg|glb|gltf|svg|json)$/i.test(val)) {
                        const newVal = rootPrefix + val.substring(1);
                        magic.overwrite(node.start, node.end, JSON.stringify(newVal));
                        hasChanges = true;
                    }
                }
            };

            walkSimple(ast, {
                ImportDeclaration: rewrite,
                ExportNamedDeclaration: rewrite,
                ExportAllDeclaration: rewrite,
                ImportExpression: (node) => {
                    if (node.source.type === 'Literal') {
                        const newVal = this.normalizeImport(node.source.value);
                        if (newVal !== node.source.value) {
                            magic.overwrite(node.source.start, node.source.end, JSON.stringify(newVal));
                            hasChanges = true;
                        }
                    }
                },
                Literal: rewritePaths
            });

        } catch (e) {
            // Regex Fallback for JSX or syntax errors (Acorn fails on JSX)
            // Matches:
            // 1. import ... from "..."
            // 2. import "..."
            // 3. export ... from "..."
            // 4. import("...") (dynamic)
            const importRegex = /(import\s+(?:[\w\s{},*]+)\s+from\s+['"])([^'"]+)(['"])|(import\s+['"])([^'"]+)(['"])|(from\s+['"])([^'"]+)(['"])|(import\s*\(\s*['"])([^'"]+)(['"]\s*\))/g;
            let match;
            const originalCode = code; 
            
            while ((match = importRegex.exec(originalCode)) !== null) {
                const url = match[2] || match[5] || match[8] || match[11];
                const prefix = match[1] || match[4] || match[7] || match[10];
                
                if (url) {
                    const newVal = this.normalizeImport(url);
                    if (newVal !== url) {
                        const start = match.index + prefix.length;
                        const end = start + url.length;
                        magic.overwrite(start, end, newVal);
                        hasChanges = true;
                    }
                }
            }
        }

        // Remotion License Injection for <Player /> components
        // We iterate all <Player> tags and ensure the prop is present.
        if (code.includes('<Player')) {
             const playerRegex = /<Player([\s\n\r/>])/g;
             let match;
             while ((match = playerRegex.exec(code)) !== null) {
                 // Check if the prop already exists in the vicinity (heuristic: next 500 chars)
                 // This avoids duplicate injection if the user already added it or if we run multiple times
                 const vicinity = code.slice(match.index, match.index + 500);
                 const closeIndex = vicinity.indexOf('>');
                 const tagContent = closeIndex > -1 ? vicinity.slice(0, closeIndex) : vicinity;
                 
                 if (!tagContent.includes('acknowledgeRemotionLicense')) {
                     // Insert prop right after <Player
                     magic.appendLeft(match.index + 7, ' acknowledgeRemotionLicense={true}');
                     hasChanges = true;
                 }
             }
        }

        return hasChanges ? magic.toString() : code;
    }

    // Process HTML: Remove import maps, extract inline scripts, inject polyfills
    processHTML(htmlContent, filename) {
        let html = uint8ToString(htmlContent);
        const extractedScripts = [];
        let scriptCounter = 0;

        // Ensure DOCTYPE
        if (!html.trim().toLowerCase().startsWith('<!doctype')) {
            html = '<!DOCTYPE html>\n' + html;
        }

        // 1. Remove Import Maps but extract dependencies first
        html = html.replace(/<script\s+type=["']importmap["'][^>]*>([\s\S]*?)<\/script>/gi, (match, content) => {
            try {
                const map = JSON.parse(content);
                if (map.imports) {
                    Object.values(map.imports).forEach(url => this.normalizeImport(url));
                }
            } catch (e) { /* ignore parse errors */ }
            return '<!-- Import Map Removed by Converter -->';
        });

        // 2. Inject Polyfills (Logger, Socket) - Now extracted to separate files in client/
        // We will inject <script src="./logger.js"></script> etc.
        const polyfills = `<script type="module" src="./logger.js"></script>\n    <script type="module" src="./websim_stubs.js"></script>\n    <script type="module" src="./websim_socket.js"></script>`;
        if (html.includes('<head>')) {
            html = html.replace('<head>', '<head>\n    ' + polyfills);
        } else {
            html = polyfills + '\n' + html;
        }

        // 3. Process Scripts
        html = html.replace(/<script([^>]*)>([\s\S]*?)<\/script>/gi, (match, attrs, content) => {
            // Check src
            const srcMatch = attrs.match(/src=["']([^"']+)["']/i);
            if (srcMatch) {
                const src = srcMatch[1];
                // If remote script (http), try to map it? 
                // Vite doesn't like remote scripts in index.html unless ignored.
                // Best practice: Download it or ignore. 
                // For this converter, we'll leave it, but warn?
                // Actually, strict CSP means we should probably leave it and let Devvit block it or user fix it.
                // But better: if it's a library, we might have mapped it? No, script tags are hard to map to npm deps automatically without import map.
                return match; 
            }

            // Inline Script -> Extract to file
            if (!content.trim()) return match;
            
            // Skip JSON/LD
            if (attrs.includes('application/json')) return match;

            scriptCounter++;
            const safeName = filename.replace(/[^\w]/g, '_');
            const newScriptName = `${safeName}_inline_${scriptCounter}.js`;
            
            // Process the content for imports too
            const processedContent = this.processJS(content, newScriptName);
            extractedScripts.push({ filename: newScriptName, content: processedContent });

            // Force type="module" for Vite compatibility usually, or just keep original type?
            // If it has imports, it must be module.
            let newAttrs = attrs;
            if (processedContent.includes('import ') && !newAttrs.includes('type="module"')) {
                newAttrs += ' type="module"';
            }

            return `<script src="./${newScriptName}" ${newAttrs}></script>`;
        });

        // 4. Remove inline event handlers (CSP) - crude regex
        html = html.replace(/\s+on\w+\s*=\s*["'][^"']*["']/gi, '');

        return { html, extractedScripts };
    }

    processCSS(cssContent, filename = 'style.css') {
        const css = uint8ToString(cssContent);
        
        const depth = (filename.match(/\//g) || []).length;
        const rootPrefix = depth > 0 ? '../'.repeat(depth) : './';

        // Replace absolute paths in url() with relative ones
        // e.g. url(/images/bg.png) -> url(./images/bg.png) or url(../images/bg.png)
        return css.replace(/url\(\s*(['"]?)(\/[^)'"]+)\1\s*\)/gi, (match, quote, path) => {
            if (path.startsWith('//')) return match; // Skip protocol-relative
            return `url(${quote}${rootPrefix}${path.substring(1)}${quote})`;
        });
    }
}

