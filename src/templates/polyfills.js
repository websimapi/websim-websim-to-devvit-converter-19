export const simpleLoggerJs = `
// [WebSim] Logger Polyfill - Global Script
(function() {
  const _log = console.log;
  const _warn = console.warn;
  const _error = console.error;
  const _info = console.info;

  function post(level, args) {
    try {
      const msgPreview = args.map(String).join(' ');
      if (msgPreview.includes('AudioContext') || msgPreview.includes('acknowledgeRemotionLicense')) return;

      const serialized = args.map(a => {
        if (a === undefined) return 'undefined';
        if (a === null) return 'null';
        if (a instanceof Error) return '[Error: ' + (a.message || 'unknown') + ']';
        if (typeof a === 'object') {
            try { return JSON.stringify(a); } catch(e) { return '[Circular]'; }
        }
        return String(a);
      });
      
      if (window.parent) {
          window.parent.postMessage(JSON.stringify({ type: 'console', level, args: serialized }), '*');
      }
    } catch(e) {}
  }

  console.log = function(...args) { _log.apply(console, args); post('info', args); };
  console.info = function(...args) { _info.apply(console, args); post('info', args); };
  console.warn = function(...args) { _warn.apply(console, args); post('warn', args); };
  console.error = function(...args) { _error.apply(console, args); post('error', args); };

  window.addEventListener('error', function(e) {
    post('error', ['[Uncaught]', e.message]);
  });
})();
`;

export const websimSocketPolyfill = `
// [WebSim] Generic DB & Bridge Polyfill
(function() {
    // 1. Generic State Store
    window._genericDB = {};
    window._subscribers = {}; // Map<collection, Function[]>

    // 2. The Bridge Logic
    const DevvitBridge = {
        send: (type, payload) => {
            // SANITIZATION: Strip out any DOM nodes or functions to prevent DataCloneError
            try {
                const cleanPayload = JSON.parse(JSON.stringify(payload || {}));
                if (window.parent) window.parent.postMessage({ type, payload: cleanPayload }, '*');
            } catch (e) { console.error('Bridge Send Error:', e); }
        },

        init: () => {
            console.log("[Bridge] Initializing...");
            
            window.addEventListener('message', (event) => {
                const data = event.data || {};
                const type = data.type;
                const payload = data.payload;

                // A. The "Magic" Hydration
                if (type === 'DB_HYDRATE') {
                    console.log("[Bridge] Database Hydrated");
                    if (payload) window._genericDB = payload;
                    
                    // Trigger generic event
                    const readyEvent = new CustomEvent('GAMEDATA_READY', { detail: payload });
                    window.dispatchEvent(readyEvent);
                    
                    // Handle Identity if sent alongside DB
                    if (data.user) {
                         if (window.WebsimSocket && window.WebsimSocket.updateIdentity) {
                             window.WebsimSocket.updateIdentity(data.user);
                         }
                         // Broadcast legacy event for stubs
                         window.postMessage({ type: 'set_user_context', payload: { user: data.user } }, '*');
                    }

                    // Notify all subscribers
                    Object.keys(window._subscribers).forEach(col => {
                         DevvitBridge.notifySubscribers(col);
                    });
                }
            });

            // B. Send the Handshake
            if (window.parent) {
                DevvitBridge.send('CLIENT_READY');
            }
        },

        notifySubscribers: (collection) => {
            if (window._subscribers[collection]) {
                const list = Object.values(window._genericDB[collection] || {});
                // Sort by created_at if possible, else default
                list.sort((a,b) => (b.created_at || 0) < (a.created_at || 0) ? -1 : 1);
                window._subscribers[collection].forEach(cb => {
                    try { cb(list); } catch(e) { console.error(e); }
                });
            }
        }
    };

    // 3. Expose a Simple API
    window.GenericDB = {
        save: (collection, key, value) => {
            if (!window._genericDB[collection]) window._genericDB[collection] = {};
            window._genericDB[collection][key] = value;
            
            // Notify local subscribers immediately (Optimistic)
            DevvitBridge.notifySubscribers(collection);

            DevvitBridge.send('DB_SAVE', { collection, key, value });
        },
        get: (collection, key) => {
            return window._genericDB[collection]?.[key] || null;
        },
        getAll: (collection) => {
            return window._genericDB[collection] || {};
        }
    };

    // 4. WebSim Socket Adapter (Backward Compatibility)
    // Maps legacy websim.collection() calls to GenericDB
    class AdapterCollection {
        constructor(name) { this.name = name; }
        
        getList() { 
            return Object.values(window.GenericDB.getAll(this.name))
                   .sort((a,b) => (b.created_at || 0) < (a.created_at || 0) ? -1 : 1);
        }
        
        async create(data) {
            const id = Math.random().toString(36).substr(2, 12);
            const record = { 
                id, 
                ...data, 
                created_at: new Date().toISOString() 
            };
            window.GenericDB.save(this.name, id, record);
            return record;
        }

        async update(id, data) {
            const current = window.GenericDB.get(this.name, id);
            if (!current) throw new Error('Record not found');
            const record = { ...current, ...data };
            window.GenericDB.save(this.name, id, record);
            return record;
        }

        async delete(id) {
             if (window._genericDB[this.name]) {
                 delete window._genericDB[this.name][id];
                 DevvitBridge.notifySubscribers(this.name);
             }
        }

        subscribe(cb) {
            if (!window._subscribers[this.name]) window._subscribers[this.name] = [];
            window._subscribers[this.name].push(cb);
            cb(this.getList());
            return () => {
                window._subscribers[this.name] = window._subscribers[this.name].filter(f => f !== cb);
            };
        }
        
        filter(criteria) {
             const self = this;
             return {
                 getList: () => self.getList().filter(r => self._matches(r, criteria)),
                 subscribe: (cb) => {
                     const wrapped = (list) => cb(list.filter(r => self._matches(r, criteria)));
                     return self.subscribe(wrapped);
                 }
             };
        }
        _matches(record, criteria) {
            for (let key in criteria) { if (record[key] !== criteria[key]) return false; }
            return true;
        }
    }

    // Stub websimSocketInstance for legacy checks
    window.websimSocketInstance = {
        collection: (name) => new AdapterCollection(name)
    };

    // Mock WebSimSocket Class (Fixes "not a constructor" error)
    window.WebsimSocket = class WebsimSocket {
        constructor() {
            // Delegate to the singleton instance
            if (!window.websimSocketInstance) {
                // Should have been created by previous lines, but safe fallback
                console.warn("[WebSimSocket] Instance not ready, creating fallback");
                window.websimSocketInstance = { collection: () => ({ subscribe:()=>{}, getList:()=>[], create:async()=>{}, update:async()=>{}, delete:async(){} }) };
            }
            return window.websimSocketInstance;
        }
        static updateIdentity(user) {
            window._currentUser = user;
        }
    };
    
    if (!window.party) { window.party = window.websimSocketInstance; }

    // Initialize Bridge
    // Use a small timeout to allow React/UI to settle before asking for data
    const startBridge = () => {
        setTimeout(DevvitBridge.init, 100);
    };

    if (document.readyState === 'complete') {
        startBridge();
    } else {
        window.addEventListener('load', startBridge);
    }
})();
`;

export const websimStubsJs = `
// [WebSim] API Stubs - Global Script
(function() {
    let _currentUser = null;

    // Listen for identity update from Socket Handshake or direct message
    const updateIdentity = (user) => {
        _currentUser = user;
        if (window.WebsimSocket && window.WebsimSocket.updateIdentity) {
            window.WebsimSocket.updateIdentity(user);
        }
    };

    // Also listen to window messages for 'set_user_context' just in case
    window.addEventListener('message', (e) => {
        let data = e.data;
        if (typeof data === 'string') { try { data = JSON.parse(data); } catch(e) {} }
        if (data && (data.type === 'set_user_context' || (data.payload && data.payload.user))) {
            const user = data.payload.user || data.payload;
            updateIdentity(user);
        }
    });

    if (!window.websim) {
        window.websim = {
            getCurrentUser: async () => {
                // Wait for handshake
                let tries = 0;
                while(!_currentUser && tries < 20) {
                    await new Promise(r => setTimeout(r, 100));
                    tries++;
                }
                return _currentUser || {
                    id: 'guest', username: 'Guest', avatar_url: 'https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png'
                };
            },
            getProject: async () => ({ id: 'local', title: 'Reddit Game' }),
            collection: (name) => {
                // Return safe stubs to prevent crashes before hydration
                return window.websimSocketInstance ? window.websimSocketInstance.collection(name) : {
                    subscribe: () => {}, 
                    getList: () => [], 
                    create: async () => {}, 
                    update: async () => {}, 
                    delete: async () => {}, 
                    filter: () => ({ subscribe: () => {}, getList: () => [] })
                };
            },
            upload: async (blob) => {
                try { return URL.createObjectURL(blob); } catch(e) { return ''; }
            }
        };
    }
})();
`;

export const jsxDevProxy = `
// Shim for react/jsx-dev-runtime to work in production Vite builds
import { Fragment as _Fragment, jsx as _jsx, jsxs as _jsxs } from 'react/jsx-runtime';

export const Fragment = _Fragment;
export const jsx = _jsx;
export const jsxs = _jsxs;

// Proxy jsxDEV to jsx (ignores the extra dev-only arguments)
export const jsxDEV = (type, props, key, isStaticChildren, source, self) => {
  return _jsx(type, props, key);
};
`;

export const websimPackageJs = `
// Bridge for "import websim from 'websim'"
const w = window.websim || {};
export default w;
// Export common methods if destructured
export const getProject = w.getProject;
export const getCurrentUser = w.getCurrentUser;
export const upload = w.upload;
export const collection = w.collection;
`;

