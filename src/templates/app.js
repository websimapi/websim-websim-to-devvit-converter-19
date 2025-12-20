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

// Add a menu item to the subreddit menu for instantiating the custom post type
Devvit.addMenuItem({
  label: 'Add Game Post',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event, context) => {
    const { reddit, ui } = context;
    const subreddit = await reddit.getCurrentSubreddit();
    const post = await reddit.submitPost({
      title: '${safeTitle}',
      subredditName: subreddit.name,
      // The preview appears while the post loads
      preview: (
        <vstack height="100%" width="100%" alignment="middle center">
          <text size="large">Loading Game...</text>
        </vstack>
      ),
    });
    ui.showToast({ text: 'Created Game Post!' });
    ui.navigateTo(post);
  },
});

Devvit.addCustomPostType({
  name: 'WebSim Game',
  height: 'tall',
  render: (context) => {
    // 1. SYSTEM STATE (Server Task Queue)
    // We bundle requestId, type, and payload into one object to ensure atomic updates.
    // This state drives the useAsync hook, which is the ONLY way to access Redis.
    const [pendingTask, setPendingTask] = useState({ 
        type: 'initial', 
        payload: null, 
        requestId: null 
    });

    // 2. SERVER WORKER (The Bridge)
    // This hook runs on the server whenever pendingTask.requestId changes.
    const { data: serverResponse } = useAsync(async () => {
        if (!pendingTask.requestId) return null;
        
        const { type, payload, requestId } = pendingTask;
        const postId = context.postId || 'global';
        const redisKeyBase = \`data:\${postId}\`;
        
        console.log(\`[Server] Processing Request: \${type}\`);

        try {
            // --- A. HANDSHAKE (Load Game State) ---
            if (type === 'handshake') {
                const collectionsStr = await context.redis.get(\`\${redisKeyBase}:meta:collections\`);
                const collections = collectionsStr ? JSON.parse(collectionsStr) : [];
                
                const dump = {};
                for (const col of collections) {
                    const data = await context.redis.hGetAll(\`\${redisKeyBase}:\${col}\`);
                    if (data) dump[col] = data;
                }
                
                return { type: 'handshake_response', payload: dump, reqId: requestId };
            }
            
            // --- B. DB WRITE OPS ---
            if (type === 'db_op') {
                const { cmd, collection, data } = payload;
                const key = \`\${redisKeyBase}:\${collection}\`;
                
                if (cmd === 'create' || cmd === 'update') {
                    // Maintain list of active collections
                    const colKey = \`\${redisKeyBase}:meta:collections\`;
                    const activeColsStr = await context.redis.get(colKey);
                    const activeCols = activeColsStr ? JSON.parse(activeColsStr) : [];
                    
                    if (!activeCols.includes(collection)) {
                        activeCols.push(collection);
                        await context.redis.set(colKey, JSON.stringify(activeCols));
                    }
                    
                    await context.redis.hSet(key, { [data.id]: JSON.stringify(data) });
                } 
                else if (cmd === 'delete') {
                    await context.redis.hDel(key, [data.id]);
                }
                
                // Return for broadcast
                return { type: 'broadcast_op', payload: payload, reqId: requestId };
            }
            
            // --- C. IDENTITY ---
            if (type === 'get_user_context') {
                let user = null;
                try { user = await context.reddit.getCurrentUser(); } catch(e) {}
                
                return {
                    type: 'user_context_res',
                    payload: {
                        id: user ? user.id : 'anon',
                        username: user ? user.username : 'Guest',
                        avatar_url: user?.snoovatarImage || 'https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png'
                    },
                    reqId: requestId
                };
            }
            
        } catch(e) {
            console.error('[Server] Error:', e);
            return { type: 'error', message: 'Server Error', reqId: requestId };
        }
        
        return null;
    }, { depends: [pendingTask.requestId] });

    // 3. REALTIME SYNC
    const channel = useChannel({
        name: \`game_\${context.postId || 'global'}\`,
        onMessage: (msg) => {
            // Pass remote events to WebView
            context.ui.webView.postMessage('gameview', {
                type: 'WEBSIM_SOCKET_EVT',
                payload: msg
            });
        }
    });
    channel.subscribe();

    // 4. RESPONSE DISPATCHER
    // When the server worker finishes, we send data back to WebView.
    if (serverResponse && serverResponse.reqId === pendingTask.requestId) {
        if (serverResponse.type === 'handshake_response') {
             context.ui.webView.postMessage('gameview', {
                 type: 'WEBSIM_SOCKET_EVT',
                 payload: { type: 'batch_dump', data: serverResponse.payload }
             });
        }
        else if (serverResponse.type === 'user_context_res') {
             context.ui.webView.postMessage('gameview', {
                 type: 'set_user_context',
                 payload: serverResponse.payload
             });
        }
        else if (serverResponse.type === 'broadcast_op') {
            // Broadcast to *other* players via Realtime
            channel.send({
                type: 'db_sync',
                collection: serverResponse.payload.collection,
                op: serverResponse.payload
            });
        }
    }

    // 5. RENDER UI
    return (
        <vstack height="100%" width="100%" alignment="center middle">
            <webview
                id="gameview"
                url="${webviewPath}"
                width="100%"
                height="100%"
                onMessage={(msg) => {
                    // Safe Parse: msg might be JSON string from Android WebView
                    let evt = msg;
                    if (typeof msg === 'string') {
                        try { evt = JSON.parse(msg); } catch(e) { return; }
                    }
                    if (!evt || !evt.type) return;
                    
                    const newReqId = Math.random().toString(36);
                    
                    // --- HANDSHAKE INITIATION ---
                    if (evt.type === 'client_ready') {
                        setPendingTask({ type: 'handshake', payload: {}, requestId: newReqId });
                    }
                    // --- DB WRITE REQUESTS ---
                    else if (evt.type === 'WEBSIM_SOCKET_MSG') {
                        const { type, payload } = evt.payload || {};
                        if (type === 'db_op') {
                            // Needs Server Auth -> Queue Task
                            setPendingTask({ type: 'db_op', payload, requestId: newReqId });
                        } else {
                            // Chat/Presence -> Direct P2P Broadcast
                            channel.send(evt.payload);
                        }
                    }
                    // --- USER INFO REQUESTS ---
                    else if (evt.type === 'get_user_context') {
                        setPendingTask({ type: 'get_user_context', payload: {}, requestId: newReqId });
                    }
                    // --- LOGGING ---
                    else if (evt.type === 'console') {
                         console.log('[Web]', ...(evt.args || []));
                    }
                }}
            />
        </vstack>
    );
  }
});

export default Devvit;
`;
};

