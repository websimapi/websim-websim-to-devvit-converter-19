export const getMainTsx = (title, webviewPath = 'index.html') => {
  const safeTitle = title.replace(/'/g, "\\'");
  return `/** @jsx Devvit.createElement */
/** @jsxFrag Devvit.Fragment */

import { Devvit, useState, useChannel, useAsync } from '@devvit/public-api';

Devvit.configure({
  redditAPI: true,
  redis: true,
  realtime: true,
});

Devvit.addCustomPostType({
  name: 'WebSim Game',
  height: 'tall',
  render: (context) => {
    // 1. STATE: Triggers for Server Actions
    const [key, setKey] = useState(0); // For manual reload
    const [syncReq, setSyncReq] = useState({ id: 0, type: '', payload: {} });
    const [lastProcessed, setLastProcessed] = useState(0);

    // 2. SERVER: useAsync (Runs on Server)
    // This hook is the ONLY place authorized to touch Redis.
    const { data: serverRes } = useAsync(async () => {
      if (!syncReq.id || syncReq.id === 0) return null;
      
      const { type, payload } = syncReq;

      try {
        // Safety check: In some environments (like playtest client-side hydration), 
        // context.redis might throw 'ServerCallRequired' immediately or be missing.
        // We catch this to prevent client-side crashes, relying on the Server-side execution to succeed.
        if (!context || !context.redis) return null;

        console.log(\`[Server] Processing Request: \${type}\`);

        // BATCH LOAD (Handshake)
        if (type === 'batch_load') {
          const collections = payload.collections || [];
          const results = {};
          
          for (const col of collections) {
            try {
               const data = await context.redis.hGetAll(\`websim:data:\${col}\`);
               results[col] = data || {};
            } catch(e) { 
                // Ignore ServerCallRequired locally, allow other errors
                if (e.message && e.message.includes('ServerCallRequired')) throw e;
                console.error(\`[Server] Redis Error loading \${col}:\`, e); 
                results[col] = {}; 
            }
          }
          console.log(\`[Server] Loaded \${collections.length} collections.\`);
          return { type: 'batch_dump', data: results, reqId: syncReq.id };
        }

        // SINGLE LOAD (Retry Mechanism)
        if (type === 'db_load') {
            const { collection } = payload;
            const data = await context.redis.hGetAll(\`websim:data:\${collection}\`);
            return { type: 'db_dump', data: data || {}, collection, reqId: syncReq.id };
        }

        // GET USER (Identity)
        if (type === 'get_user_context') {
            try {
                const user = await context.reddit.getCurrentUser();
                return { 
                    type: 'user_context_res', 
                    data: {
                        id: user.id,
                        username: user.username,
                        avatar_url: user.snoovatarImage || 'https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png'
                    }, 
                    reqId: syncReq.id 
                };
            } catch(e) {
                // Return anon if user fetch fails (or if on client and it throws)
                return { 
                    type: 'user_context_res', 
                    data: { id: 'anon', username: 'Anonymous', avatar_url: 'https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png' }, 
                    reqId: syncReq.id 
                };
            }
        }
        
        // DB OPS
        if (type === 'db_op') {
           const { cmd, collection, data } = payload;
           const redisKey = \`websim:data:\${collection}\`;
           
           if (cmd === 'create' || cmd === 'update') {
               await context.redis.hSet(redisKey, { [data.id]: JSON.stringify(data) });
           } else if (cmd === 'delete') {
               await context.redis.hDel(redisKey, [data.id]);
           }
           
           return { type: 'broadcast_op', payload, reqId: syncReq.id };
        }

      } catch (err) {
        // CRITICAL FIX: Ignore "ServerCallRequired" errors.
        // These happen because useAsync sometimes attempts to run on the Client (WebView/Worker) 
        // during hydration updates. We must swallow this error so the Client doesn't crash.
        // The real Server-side execution will succeed and return the data.
        if (err.message && err.message.includes('ServerCallRequired')) {
            return null;
        }

        console.error('[Server] Error:', err);
        return { type: 'error', error: String(err), reqId: syncReq.id };
      }
      return null;
    }, { depends: [syncReq.id] });

    // 3. REALTIME: Channel
    const channel = useChannel({
      name: 'websim_global',
      onMessage: (msg) => {
        // Forward to WebView
        context.ui.webView.postMessage('gameview_' + key, {
          type: 'WEBSIM_SOCKET_EVT',
          payload: msg
        });
      },
    });
    channel.subscribe();

    // 4. CLIENT: Process Server Results
    if (serverRes && serverRes.reqId !== lastProcessed) {
        setLastProcessed(serverRes.reqId);
        
        if (serverRes.type === 'batch_dump') {
            // Send Data to WebView (Stringified for safety)
            context.ui.webView.postMessage('gameview_' + key, JSON.stringify({
                type: 'WEBSIM_SOCKET_EVT',
                payload: { type: 'batch_dump', data: serverRes.data }
            }));
        }
        else if (serverRes.type === 'db_dump') {
            // Send Single Collection Dump
            context.ui.webView.postMessage('gameview_' + key, JSON.stringify({
                type: 'WEBSIM_SOCKET_EVT',
                payload: { type: 'db_dump', data: serverRes.data, collection: serverRes.collection }
            }));
        }
        else if (serverRes.type === 'user_context_res') {
             context.ui.webView.postMessage('gameview_' + key, JSON.stringify({
                type: 'set_user_context',
                payload: serverRes.data
             }));
        }
        else if (serverRes.type === 'broadcast_op') {
            // Broadcast to others
             channel.send({
                type: 'db_sync',
                collection: serverRes.payload.collection,
                op: serverRes.payload
            });
        }
    }

    // 5. RENDER
    return (
      <vstack height="100%" width="100%" alignment="center middle">
        <webview
          id={'gameview_' + key}
          url="${webviewPath}"
          width="100%"
          height="100%"
          onMessage={(event) => {
            let msg = event;
            if (typeof msg === 'string') { try { msg = JSON.parse(msg); } catch(e){} }
            if (!msg || typeof msg !== 'object') return;

            // --- HANDSHAKE ---
            if (msg.type === 'webViewReady') {
                console.log('[Client] Handshake received. Fetching Redis data...');
                setSyncReq({
                    id: Math.random(),
                    type: 'batch_load',
                    payload: { collections: msg.payload?.collections || [] }
                });
            }
            
            // --- WEBSIM SOCKET ---
            else if (msg.type === 'WEBSIM_SOCKET_MSG') {
                const { type, payload } = msg.payload || {};
                
                // Routes DB writes to Server (via State)
                if (type === 'db_op') {
                     setSyncReq({
                        id: Math.random(),
                        type: 'db_op',
                        payload: payload
                    });
                }
                // Routes DB Loads (Retries) to Server
                else if (type === 'db_load') {
                    setSyncReq({
                        id: Math.random(),
                        type: 'db_load',
                        payload: payload
                    });
                }
                // Routes standard broadcasts to Realtime (Direct)
                else {
                    channel.send(msg.payload);
                }
            }
            
            // --- USER CONTEXT ---
            else if (msg.type === 'get_user_context') {
                 // Defer to Server (prevents ServerCallRequired)
                 setSyncReq({
                    id: Math.random(),
                    type: 'get_user_context',
                    payload: {}
                 });
            }
            
            // --- LOGGING ---
            else if (msg.type === 'console') {
                const args = ['[Web]', ...(msg.args || [])];
                if (msg.level === 'error') console.error(...args);
                else console.log(...args);
            }
          }}
        />
        <vstack padding="small">
          <button size="small" appearance="bordered" icon="refresh" onPress={() => setKey(k => k + 1)}>Reload</button>
        </vstack>
      </vstack>
    );
  },
});

Devvit.addMenuItem({
  label: 'Create ${safeTitle}',
  location: 'subreddit',
  onPress: async (_event, context) => {
    const { reddit, ui } = context;
    try {
      const subreddit = await reddit.getCurrentSubreddit();
      const post = await reddit.submitPost({
        title: '${safeTitle}',
        subredditName: subreddit.name,
        preview: (
          <vstack height="100%" width="100%" alignment="center middle">
            <text size="large">Loading Game...</text>
          </vstack>
        ),
      });
      ui.showToast('Game created!');
      ui.navigateTo(post);
    } catch (error) {
      console.error('Error creating post:', error);
      ui.showToast('Failed to create game post');
    }
  },
});

export default Devvit;
`;
};

