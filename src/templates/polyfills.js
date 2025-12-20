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
// [WebSim] Socket & Redis Polyfill - Global Script
(function() {
    console.log('[WebSim Socket] Initializing...');

    const _roomState = {};
    const _presence = {};
    const _peers = {};
    const _clientId = Math.random().toString(36).substr(2, 9);

    // Initial Identity (Anonymous)
    _peers[_clientId] = { 
        username: 'Guest', 
        avatarUrl: 'https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png',
        id: _clientId 
    };
    _presence[_clientId] = {};

    class WebsimCollection {
        constructor(name, socket) {
            this.name = name;
            this.socket = socket;
            this.records = [];
            this.subs = [];
            this.loaded = false;
        }

        getList() {
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
            
            // Optimistic
            this._handleOp({ cmd: 'create', data: record });
            
            // Send to Host
            this.socket._sendInternal('db_op', { cmd: 'create', collection: this.name, data: record });
            return record;
        }

        async update(id, data) {
            const current = this.records.find(r => r.id === id);
            if (!current) throw new Error("Record not found");
            const record = { ...current, ...data };
            
            this._handleOp({ cmd: 'update', data: record });
            this.socket._sendInternal('db_op', { cmd: 'update', collection: this.name, data: record });
            return record;
        }
        
        async delete(id) {
            this._handleOp({ cmd: 'delete', data: { id } });
            this.socket._sendInternal('db_op', { cmd: 'delete', collection: this.name, data: { id } });
        }

        subscribe(cb) {
            this.subs.push(cb);
            cb(this.getList());
            return () => { this.subs = this.subs.filter(s => s !== cb); };
        }

        filter(criteria) {
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
                if (!this.records.find(r => r.id === op.data.id)) this.records.push(op.data);
            } else if (op.cmd === 'update') {
                const idx = this.records.findIndex(r => r.id === op.data.id);
                if (idx !== -1) this.records[idx] = op.data;
            } else if (op.cmd === 'delete') {
                this.records = this.records.filter(r => r.id !== op.data.id);
            }
            const list = this.getList();
            this.subs.forEach(cb => cb(list));
        }
        
        _handleDump(dataMap) {
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
            this.collections = {}; 
            this.initialDataCache = {};
            this.handshakeComplete = false;

            window.addEventListener('message', (e) => {
                let data = e.data;
                if (typeof data === 'string') { try { data = JSON.parse(data); } catch(err) { return; } }
                if (!data || data.type !== 'WEBSIM_SOCKET_EVT') return;
                
                const payload = data.payload || {};
                
                if (payload.type === 'batch_dump') {
                    console.log('[WebSim Socket] Handshake Received (Data+Identity)');
                    this.handshakeComplete = true;
                    this.initialDataCache = payload.data || {};
                    Object.entries(this.initialDataCache).forEach(([colName, colData]) => {
                        if (this.collections[colName]) this.collections[colName]._handleDump(colData);
                    });
                    
                    // Handle Identity if present in dump
                    if (payload.user) {
                        WebsimSocket.updateIdentity(payload.user);
                    }
                    return;
                }
                
                if (payload.type === 'db_sync') {
                    if (this.collections[payload.collection]) {
                        this.collections[payload.collection]._handleOp(payload.op);
                    }
                    return;
                }

                if (payload.senderId === this.clientId) return;
                this._handleRemoteEvent(payload.type, payload.payload, payload.senderId);
            });
            
            // Auto-start Handshake
            this._startHandshake();
        }

        _startHandshake() {
            const send = () => {
                if (this.handshakeComplete) return;
                window.parent.postMessage({ type: 'webViewReady' }, '*');
                setTimeout(send, 1000);
            };
            setTimeout(send, 100);
        }

        collection(name) {
            if (!this.collections[name]) {
                this.collections[name] = new WebsimCollection(name, this);
                if (this.initialDataCache[name]) {
                    this.collections[name]._handleDump(this.initialDataCache[name]);
                }
            }
            return this.collections[name];
        }

        send(eventData) {
            this._sendInternal('broadcast_event', eventData);
        }
        
        emit(event, data) {
            this.send({ type: event, ...data });
        }
        
        _sendInternal(msgType, data) {
            window.parent.postMessage(JSON.stringify({
                type: 'WEBSIM_SOCKET_MSG',
                payload: {
                    type: msgType,
                    payload: data,
                    senderId: this.clientId
                }
            }), '*');
        }

        _handleRemoteEvent(type, data, senderId) {
            if (!this.peers[senderId]) {
                this.peers[senderId] = { id: senderId, username: 'User ' + senderId.substr(0,4), avatarUrl: '' };
            }
            if (type === 'broadcast_event' && this.onmessage) {
                this.onmessage({ data: { ...data, clientId: senderId } });
            }
        }
        
        _on(event, cb) { return () => {}; } // simplified
    }

    const socket = new WebsimSocket();
    window.websimSocketInstance = socket;
    window.WebsimSocket = WebsimSocket;

    WebsimSocket.updateIdentity = (user) => {
        if (!user || !_peers[_clientId]) return;
        _peers[_clientId].username = user.username;
        _peers[_clientId].avatarUrl = user.avatar_url;
        // console.log('[WebSim] Identity Updated:', user.username);
    };

    if (!window.party) { window.party = socket; window.party.room = socket; }
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
                return window.websimSocketInstance ? window.websimSocketInstance.collection(name) : {
                    subscribe:()=>{}, getList:()=>[], create:async()=>{}, update:async()=>{}, delete:async(){}, filter:()=>({subscribe:()=>{},getList:()=>[]})
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

