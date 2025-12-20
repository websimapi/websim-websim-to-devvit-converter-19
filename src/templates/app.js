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
    // 1. STATE MANAGEMENT
    const [gameKey, setGameKey] = useState(0);
    // Unique ID triggers server ops. 
    // We isolate all Redis logic to useAsync which only runs when this ID changes.
    const [requestId, setRequestId] = useState(''); 
    const [requestType, setRequestType] = useState('');
    const [requestPayload, setRequestPayload] = useState({});

    // 2. SERVER SIDE LOGIC (useAsync)
    // This hook is the ONLY place authorized to touch Redis.
    const { data: serverResponse } = useAsync(async () => {
        if (!requestId) return null;
        
        // Scope data to the current post to avoid cross-post contamination
        const postId = context.postId || 'global';
        const redisKeyBase = \`data:\${postId}\`;
        
        try {
            // A. HANDSHAKE (Load Everything)
            if (requestType === 'handshake') {
                // Get list of known collections for this post from a meta-key
                const collectionsStr = await context.redis.get(\`\${redisKeyBase}:meta:collections\`);
                const collections = collectionsStr ? JSON.parse(collectionsStr) : [];
                
                const dump = {};
                // Fetch all collections serially (Redis parallel limits)
                for (const col of collections) {
                    const data = await context.redis.hGetAll(\`\${redisKeyBase}:\${col}\`);
                    if (data) dump[col] = data;
                }
                
                return { 
                    type: 'handshake_response', 
                    payload: dump,
                    reqId: requestId 
                };
            }
            
            // B. DB OPERATIONS
            if (requestType === 'db_op') {
                const { cmd, collection, data } = requestPayload;
                const key = \`\${redisKeyBase}:\${collection}\`;
                
                if (cmd === 'create' || cmd === 'update') {
                    // Update Meta Collection List if new
                    const colKey = \`\${redisKeyBase}:meta:collections\`;
                    const collectionsStr = await context.redis.get(colKey);
                    const collections = collectionsStr ? JSON.parse(collectionsStr) : [];
                    
                    if (!collections.includes(collection)) {
                        collections.push(collection);
                        await context.redis.set(colKey, JSON.stringify(collections));
                    }
                    
                    // Perform Op
                    await context.redis.hSet(key, { [data.id]: JSON.stringify(data) });
                } 
                else if (cmd === 'delete') {
                    await context.redis.hDel(key, [data.id]);
                }
                
                return { 
                    type: 'broadcast_op', 
                    payload: { ...requestPayload },
                    reqId: requestId 
                };
            }
            
            // C. USER CONTEXT
            if (requestType === 'get_user_context') {
                let user = null;
                try {
                    user = await context.reddit.getCurrentUser();
                } catch(e) {
                    // Anonymous / Logged out / Error
                }
                
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
            // Ignore ServerCallRequired locally if it happens during hydration
            if (e.message && e.message.includes('ServerCallRequired')) return null;
            
            console.error('[Server] Async Error:', e);
            return { type: 'error', message: String(e), reqId: requestId };
        }
        
        return null;
    }, { depends: [requestId] }); // DEPENDS ON REQUEST ID ONLY

    // 3. REALTIME CHANNEL
    const channel = useChannel({
        name: \`game_\${context.postId || 'global'}\`,
        onMessage: (msg) => {
            // Forward socket events to WebView
            context.ui.webView.postMessage('gameview', {
                type: 'WEBSIM_SOCKET_EVT',
                payload: msg
            });
        }
    });
    channel.subscribe();

    // 4. CLIENT RESPONSE HANDLER (Bridge Server -> WebView)
    if (serverResponse && serverResponse.reqId === requestId) {
        // Send response to WebView
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
            // Broadcast DB changes to OTHER clients via Realtime
            channel.send({
                type: 'db_sync',
                collection: serverResponse.payload.collection,
                op: serverResponse.payload
            });
        }
        
        // Note: We don't reset requestId here to avoid infinite render loops.
        // The WebView initiates the request and handles the single response.
    }

    // 5. RENDER
    return (
        <vstack height="100%" width="100%" alignment="center middle">
            <webview
                id="gameview"
                url="${webviewPath}"
                width="100%"
                height="100%"
                onMessage={(msg) => {
                    if (!msg || !msg.type) return;
                    
                    const newReqId = Math.random().toString();
                    
                    // --- HANDSHAKE ---
                    if (msg.type === 'webViewReady') {
                        setRequestType('handshake');
                        setRequestPayload({});
                        setRequestId(newReqId);
                    }
                    // --- USER CONTEXT ---
                    else if (msg.type === 'get_user_context') {
                        setRequestType('get_user_context');
                        setRequestPayload({});
                        setRequestId(newReqId);
                    }
                    // --- SOCKET/DB OPS ---
                    else if (msg.type === 'WEBSIM_SOCKET_MSG') {
                        const { type, payload } = msg.payload || {};
                        
                        if (type === 'db_op') {
                            // Queue DB operation for Server
                            setRequestType('db_op');
                            setRequestPayload(payload);
                            setRequestId(newReqId);
                        } else {
                            // Direct broadcast (presence, chat) - bypass Redis, go straight to Channel
                            channel.send(msg.payload);
                        }
                    }
                    // --- LOGGING ---
                    else if (msg.type === 'console') {
                        const args = ['[Web]', ...(msg.args || [])];
                        if (msg.level === 'error') console.error(...args);
                        else console.log(...args);
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

