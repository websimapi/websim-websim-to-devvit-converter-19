export const simpleLoggerJs = `
(function() {
  // Enhanced logger that forwards console events to Devvit host
  const _log = console.log;
  const _warn = console.warn;
  const _error = console.error;
  const _info = console.info;

  function post(level, args) {
    try {
      // Filter out noisy/irrelevant logs
      const msgPreview = args.map(String).join(' ');
      if (msgPreview.includes('AudioContext was prevented') || 
          msgPreview.includes('acknowledgeRemotionLicense')) {
          return;
      }

      // Robust serialization to string for Devvit consumption
      const serialized = args.map(a => {
        if (a === undefined) return 'undefined';
        if (a === null) return 'null';
        if (a instanceof Error) return '[Error: ' + (a.message || 'unknown') + ']\\n' + (a.stack || '');
        if (typeof a === 'object') {
            try { 
                return JSON.stringify(a, (key, value) => {
                    if (typeof value === 'function') return '[Function]';
                    return value;
                }); 
            } catch(e) { return '[Circular/Object]'; }
        }
        return String(a);
      });
      
      // Send to parent (Devvit WebView wrapper)
      // We JSON.stringify to ensure compatibility with Android WebViews
      window.parent.postMessage(JSON.stringify({ type: 'console', level, args: serialized }), '*');
      
    } catch(e) {
        // Fallback
    }
  }

  // Override console methods
  console.log = function(...args) { _log.apply(console, args); post('info', args); };
  console.info = function(...args) { _info.apply(console, args); post('info', args); };
  console.warn = function(...args) { _warn.apply(console, args); post('warn', args); };
  console.error = function(...args) { _error.apply(console, args); post('error', args); };

  // Global Error Handler
  window.addEventListener('error', function(e) {
    post('error', ['[Uncaught Exception]', e.message, 'at', e.filename, ':', e.lineno, 'col', e.colno]);
  });
  
  // Promise Rejection Handler
  window.addEventListener('unhandledrejection', function(e) {
    post('error', ['[Unhandled Promise Rejection]', e.reason ? (e.reason.message || e.reason) : 'Unknown']);
  });

  // --- AudioContext Autoplay Fix ---
  // Browsers block AudioContext autoplay. We hook into creation to resume on first interaction.
  try {
      const _AudioContext = window.AudioContext || window.webkitAudioContext;
      if (_AudioContext) {
          const contexts = new Set();
          // Polyfill the constructor to track instances
          // We wrap in a try-catch to ensure we don't break the game if native inheritance fails
          class AudioContextPolyfill extends _AudioContext {
              constructor(opts) {
                  super(opts);
                  contexts.add(this);
              }
          }
          
          window.AudioContext = AudioContextPolyfill;
          window.webkitAudioContext = AudioContextPolyfill;
    
          const resumeAll = () => {
              contexts.forEach(ctx => {
                  try {
                      if (ctx.state === 'suspended') {
                          ctx.resume().catch(() => {});
                      }
                  } catch(e) {}
              });
          };
    
          // Listen for any interaction to unlock audio
          ['click', 'touchstart', 'touchend', 'pointerdown', 'pointerup', 'keydown', 'mousedown'].forEach(evt => 
              window.addEventListener(evt, resumeAll, { once: true, capture: true })
          );
      }
  } catch(e) {
      console.warn('[WebSim] AudioContext polyfill failed', e);
  }

  // Signal ready
  console.log('[WebSim Logger] Bridge initialized.');
})();
`;

export const websimSocketPolyfill = `
// WebSim Socket Polyfill -> Reddit Devvit Realtime Bridge
// This module bridges the WebSim "Room" API to Reddit's Realtime Channels.
// It uses a postMessage bridge to the parent Devvit Block which handles the actual Realtime connection.

console.log('[WebSim Socket] Initializing Realtime Bridge...');

// Global State (Synced with Room)
const _roomState = {};
const _presence = {};
const _peers = {};
const _clientId = Math.random().toString(36).substr(2, 9); // Temporary ID until we get real one

// Self Initialization
_peers[_clientId] = { 
    username: 'Player ' + _clientId.substr(0,4), 
    avatarUrl: 'https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png',
    id: _clientId 
};
_presence[_clientId] = {};

class WebsimCollection {
    constructor(name, socket) {
        this.name = name;
        this.socket = socket;
        this.records = []; // Local cache
        this.subs = [];
        this.loaded = false;
        
        // Request initial load with retry
        this._requestLoad();
    }

    _requestLoad(attempt = 0) {
        // Wait slightly for socket/bridge to stabilize
        // Exponential backoff to prevent flooding Devvit server which causes "ServerCallRequired"
        const delay = attempt === 0 ? 500 : Math.min(2000 * Math.pow(1.5, attempt), 10000);
        
        setTimeout(() => {
            if (this.loaded) return;
            
            // If still not loaded after a few tries, log warning but keep trying
            if (attempt > 0 && attempt % 2 === 0) {
                 console.log(\`[WebSim Socket] Syncing \${this.name}... (attempt \${attempt})\`);
            }
            
            this.socket._sendInternal('db_load', { collection: this.name });
            
            // Schedule retry if not loaded
            if (attempt < 10) {
                this._retryTimer = setTimeout(() => {
                    if (!this.loaded) this._requestLoad(attempt + 1);
                }, 5000 + (attempt * 1000)); // Increase timeout for response
            }
        }, delay);
    }

    getList() {
        // Return records sorted by created_at desc
        return this.records.sort((a,b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    }

    async create(data) {
        const id = Math.random().toString(36).substr(2, 12);
        const record = {
            id,
            ...data,
            created_at: new Date().toISOString(),
            username: this.socket.peers[this.socket.clientId]?.username || 'User'
        };
        
        // Optimistic Update
        this._handleOp({ cmd: 'create', data: record });
        
        // Persist
        this.socket._sendInternal('db_op', { 
            cmd: 'create', 
            collection: this.name, 
            data: record 
        });
        
        return record;
    }

    async update(id, data) {
        const current = this.records.find(r => r.id === id);
        if (!current) throw new Error("Record not found");
        
        const record = { ...current, ...data };
        
        // Optimistic
        this._handleOp({ cmd: 'update', data: record });
        
        // Persist
        this.socket._sendInternal('db_op', { 
            cmd: 'update', 
            collection: this.name, 
            data: record 
        });
        return record;
    }
    
    async delete(id) {
        // Optimistic
        this._handleOp({ cmd: 'delete', data: { id } });
        
        // Persist
        this.socket._sendInternal('db_op', { 
            cmd: 'delete', 
            collection: this.name, 
            data: { id } 
        });
    }

    subscribe(cb) {
        this.subs.push(cb);
        cb(this.getList());
        return () => { this.subs = this.subs.filter(s => s !== cb); };
    }

    filter(criteria) {
        // Simple client-side filter wrapper
        const self = this;
        return {
            getList: () => self.getList().filter(r => self._matches(r, criteria)),
            subscribe: (cb) => {
                const wrapped = (list) => cb(list.filter(r => self._matches(r, criteria)));
                self.subs.push(wrapped);
                wrapped(self.getList());
                return () => { self.subs = self.subs.filter(s => s !== wrapped); };
            }
        };
    }
    
    _matches(record, criteria) {
        for (let key in criteria) {
            if (record[key] !== criteria[key]) return false;
        }
        return true;
    }

    _handleOp(op) {
        if (op.cmd === 'create') {
            // Avoid duplicates
            if (!this.records.find(r => r.id === op.data.id)) {
                this.records.push(op.data);
            }
        } else if (op.cmd === 'update') {
            const idx = this.records.findIndex(r => r.id === op.data.id);
            if (idx !== -1) this.records[idx] = op.data;
        } else if (op.cmd === 'delete') {
            this.records = this.records.filter(r => r.id !== op.data.id);
        }
        
        // Trigger Subs
        const list = this.getList();
        this.subs.forEach(cb => cb(list));
    }
    
    _handleDump(dataMap) {
        if (this._retryTimer) clearTimeout(this._retryTimer);
        
        // dataMap is object { id: jsonString }
        this.records = Object.values(dataMap).map(s => {
            try { return typeof s === 'string' ? JSON.parse(s) : s; } catch(e) { return null; }
        }).filter(Boolean);
        
        this.loaded = true;
        const list = this.getList();
        this.subs.forEach(cb => cb(list));
    }
}

class WebsimSocket {
    constructor() {
        this.clientId = _clientId;
        this.roomState = _roomState;
        this.presence = _presence;
        this.peers = _peers;
        this.listeners = {};
        this.collections = {}; // Cache of WebsimCollection instances
        this.connected = false;

        // Listen for messages from Parent (Devvit Host)
        window.addEventListener('message', (e) => {
            let data = e.data;
            // Parse if string (from Android/strict implementations)
            if (typeof data === 'string') {
                try { data = JSON.parse(data); } catch(err) { return; }
            }

            // Filter only our bridge events
            if (!data || data.type !== 'WEBSIM_SOCKET_EVT') return;
            
            // Note: DB Dump events might not have 'senderId' or standard shape, handle broadly
            const payload = data.payload || {};
            
            // 1. Handle DB Dump (Initial Load)
            if (payload.type === 'db_dump') {
                if (this.collections[payload.collection]) {
                    this.collections[payload.collection]._handleDump(payload.data);
                }
                return;
            }

            // 1.5 Handle Batch Dump (Handshake Response)
            if (payload.type === 'batch_dump') {
                const results = payload.data || {};
                Object.entries(results).forEach(([colName, colData]) => {
                    if (this.collections[colName]) {
                        this.collections[colName]._handleDump(colData);
                    }
                });
                return;
            }
            
            // 2. Handle DB Sync (Realtime broadcast from server)
            if (payload.type === 'db_sync') {
                if (this.collections[payload.collection]) {
                    this.collections[payload.collection]._handleOp(payload.op);
                }
                return;
            }

            // 3. Standard Room Events
            const { type, payload: msgData, senderId } = payload;
            
            // Ignore echoes from self for standard room events
            if (senderId === this.clientId) return;

            this._handleRemoteEvent(type, msgData, senderId);
        });
    }

    collection(name) {
        if (!this.collections[name]) {
            this.collections[name] = new WebsimCollection(name, this);
        }
        return this.collections[name];
    }

    async initialize() {
        console.log('[WebSim Socket] Connecting to room...');
        this.connected = true;
        
        // Delay join slightly to ensure server channel is ready
        setTimeout(() => {
            this._sendInternal('join', { 
                username: this.peers[this.clientId].username,
                avatarUrl: this.peers[this.clientId].avatarUrl
            });
            
            // Trigger Handshake
            this.sendHandshake();
        }, 1000);
        
        return Promise.resolve();
    }

    sendHandshake() {
        // Collect all currently registered collections
        const colNames = Object.keys(this.collections);
        console.log('[WebSim Socket] Sending Ready Handshake for collections:', colNames);
        window.parent.postMessage({ 
            type: 'webViewReady', 
            payload: { collections: colNames } 
        }, '*');
    }

    updatePresence(update) {
        const current = this.presence[this.clientId] || {};
        this.presence[this.clientId] = { ...current, ...update };
        
        // Optimistic update locally
        this._emit('presence', this.presence);
        
        // Broadcast
        this._sendInternal('presence_update', update);
    }

    updateRoomState(update) {
        Object.assign(this.roomState, update);
        
        // Optimistic update locally
        this._emit('roomState', this.roomState);
        
        // Broadcast
        this._sendInternal('room_state_update', update);
    }

    requestPresenceUpdate(targetClientId, data) {
         this._sendInternal('request_presence', { targetClientId, data });
    }

    send(eventData) {
        this._sendInternal('broadcast_event', eventData);
    }
    
    // Legacy support for socket.emit
    emit(event, data) {
        this.send({ type: event, ...data });
    }
    
    // Default handler, user can override
    onmessage(event) {
        // console.log('[WebSim Socket] Event:', event);
    }

    subscribePresence(callback) {
        return this._on('presence', callback);
    }

    subscribeRoomState(callback) {
        return this._on('roomState', callback);
    }
    
    subscribePresenceUpdateRequests(callback) {
        return this._on('presence_request', callback);
    }

    // INTERNAL: Send to Devvit Parent via postMessage
    _sendInternal(msgType, data) {
        // We use JSON.stringify to ensure compatibility with Android WebViews
        window.parent.postMessage(JSON.stringify({
            type: 'WEBSIM_SOCKET_MSG',
            payload: {
                type: msgType,
                payload: data,
                senderId: this.clientId
            }
        }), '*');
    }

    // INTERNAL: Handle incoming events from Devvit Parent
    _handleRemoteEvent(type, data, senderId) {
        if (!this.peers[senderId]) {
            this.peers[senderId] = { 
                id: senderId, 
                username: 'User ' + senderId.substr(0,4),
                avatarUrl: ''
            };
        }

        switch(type) {
            case 'join':
                this.peers[senderId] = { ...this.peers[senderId], ...data };
                // Reply with our presence so they know about us
                this._sendInternal('presence_update', this.presence[this.clientId] || {});
                break;
            case 'presence_update':
                this.presence[senderId] = { ...(this.presence[senderId] || {}), ...data };
                this._emit('presence', this.presence);
                break;
            case 'room_state_update':
                Object.assign(this.roomState, data);
                this._emit('roomState', this.roomState);
                break;
            case 'broadcast_event':
                if (this.onmessage) {
                    this.onmessage({ 
                        data: { 
                            ...data, 
                            clientId: senderId, 
                            username: this.peers[senderId].username 
                        } 
                    });
                }
                break;
            case 'request_presence':
                if (data.targetClientId === this.clientId) {
                    this._emit('presence_request', data.data, senderId);
                }
                break;
        }
    }

    _on(event, cb) {
        if (!this.listeners[event]) this.listeners[event] = [];
        this.listeners[event].push(cb);
        return () => {
            this.listeners[event] = this.listeners[event].filter(x => x !== cb);
        };
    }

    _emit(event, ...args) {
        if (this.listeners[event]) {
            this.listeners[event].forEach(cb => {
                try { cb(...args); } catch(e) { console.error(e); }
            });
        }
    }
}

// Singleton Instance
const socket = new WebsimSocket();
window.websimSocketInstance = socket;

WebsimSocket.updateIdentity = (user) => {
    if (!user || !_peers[_clientId]) return;
    _peers[_clientId].username = user.username;
    _peers[_clientId].avatarUrl = user.avatar_url;
};

// Expose Global (WebSim Standard)
window.WebsimSocket = WebsimSocket;

// Expose 'room' instance globally if not present
// Many WebSim apps use 'const room = new WebsimSocket()' but since we're polyfilling,
// we often need to hook into existing code. 
// For this environment, we just ensure the class is available.

// PartyKit / Multiplayer Polyfills for other common libraries
if (!window.party) {
    window.party = socket;
    window.party.room = socket; // Alias
}

export default socket;
`;

export const websimStubsJs = `
// WebSim API Stubs for standalone running
(function() {
    // Identity Cache
    let _currentUser = null;

    // Listen for identity from Devvit Parent
    window.addEventListener('message', (e) => {
        let data = e.data;
        if (typeof data === 'string') { try { data = JSON.parse(data); } catch(e) {} }
        
        if (data && data.type === 'set_user_context') {
            console.log('[WebSim] Identity received:', data.payload.username);
            _currentUser = data.payload;
            
            // Also update socket identity if available
            if (window.WebsimSocket && window.WebsimSocket.updateIdentity) {
                window.WebsimSocket.updateIdentity(_currentUser);
            }
        }
    });

    // Request identity immediately
    if (window.parent) {
        window.parent.postMessage(JSON.stringify({ type: 'get_user_context' }), '*');
    }

    if (!window.websim) {
      window.websim = {
        getCurrentUser: async () => {
            // Wait a bit for identity handshake if not ready
            if (!_currentUser) {
                // Return a temporary promise that checks every 100ms for 1s
                let attempts = 0;
                while(!_currentUser && attempts < 10) {
                    await new Promise(r => setTimeout(r, 100));
                    attempts++;
                }
            }
            // Fallback if still null
            if (!_currentUser) {
                _currentUser = {
                    id: 'user_' + Math.random().toString(36).substr(2,9),
                    username: 'Guest',
                    avatar_url: 'https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png'
                };
            }
            return _currentUser;
        },
        getProject: async () => ({
            id: 'local_project',
            title: 'Local Game'
        }),
        // Map websim.collection to the socket-based redis collection
        collection: (name) => {
            const sock = window.websimSocketInstance || (window.party) || new window.WebsimSocket();
            if (sock && sock.collection) {
                return sock.collection(name);
            }
            console.warn('[WebSim Stub] Could not resolve socket for collection:', name);
            // Fallback mock to prevent crash
            return { 
                subscribe:()=>{}, 
                getList:()=>[], 
                create:async()=>{}, 
                update:async()=>{}, 
                delete:async()=>{},
                filter: () => ({ subscribe:()=>{}, getList:()=>[] })
            };
        },
        // Polyfill upload to prevent crashes
        upload: async (blob) => {
            console.warn('[WebSim Stub] window.websim.upload called. Uploads are not fully supported in WebView.');
            
            // Blob URLs can sometimes trigger CSP violations in Devvit.
            // If it's an image, we try to create a data URL instead if it's small, 
            // but for now, we just return the blob URL and hope CSP allows it for <img src>
            try {
                return URL.createObjectURL(blob);
            } catch(e) {
                console.error('Failed to create object URL', e);
                return '';
            }
        },
        // Generic internal stubs
        internal: {
            // Helper to detect if running in Devvit
            isDevvit: true
        }
      };
    }

    // CORS Proxy Interceptor
    // Many WebSim games use proxy services to fetch external images. Devvit CSP blocks these.
    // We try to unwrap them if they point to allowed domains (like redditstatic), or just fail gracefully.
    const _fetch = window.fetch;
    window.fetch = function(input, init) {
        if (typeof input === 'string') {
            // Check for common proxies
            if (input.includes('api.cors.lol') || input.includes('api.codetabs.com') || input.includes('everyorigin.workers.dev')) {
                // Try to extract the real URL
                const urlMatch = input.match(/[?&](url|quest)=([^&]+)/);
                if (urlMatch && urlMatch[2]) {
                    const realUrl = decodeURIComponent(urlMatch[2]);
                    // If it's a reddit URL, use it directly (allowed by CSP)
                    if (realUrl.includes('reddit') || realUrl.includes('redd.it')) {
                        return _fetch(realUrl, init);
                    }
                }
            }
        }
        return _fetch(input, init);
    };
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
// We safely access window.websim, defaulting to empty object to prevent crashes
const w = (typeof window !== 'undefined' && window.websim) ? window.websim : {};

export default w;

// Export common methods if destructured - safely accessed
export const getProject = w.getProject;
export const getCurrentUser = w.getCurrentUser;
export const upload = w.upload;
export const collection = w.collection;
`;

