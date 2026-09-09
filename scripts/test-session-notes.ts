/** Real notes editor regression fixture. Run with `bun scripts/test-session-notes.ts`.
 * In-memory client; no production sessions or database are accessed. */
const built = await Bun.build({ entrypoints: ['notes-fixture'], target: 'browser', plugins: [{ name: 'notes-fixture', setup(build) {
  build.onResolve({ filter: /^notes-fixture$/ }, () => ({ path: 'fixture', namespace: 'fixture' }));
  build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ loader: 'tsx', resolveDir: process.cwd(), contents: `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { SessionNotes } from './packages/ui/src/components/SessionNotes';
    const rows = window.rows = { a: {sessionId:'a',content:'Original',revision:1,updatedAt:1}, b: {sessionId:'b',content:'Other session',revision:1,updatedAt:1} };
    const client = {
      getSessionNotes: async id => ({...rows[id]}),
      saveSessionNotes: async (id,content,revision) => { if(revision!==rows[id].revision) throw new Error('Notes changed elsewhere'); return rows[id]={sessionId:id,content,revision:revision+1,updatedAt:Date.now()}; }
    };
    function App(){const [id,setId]=useState('a'); const [has,setHas]=useState(false); return <><button id="switch" onClick={()=>setId(id==='a'?'b':'a')}>Switch session</button><div style={{height:600}}><SessionNotes key={id} client={client as any} sessionId={id} sessionName={id} onHasNotes={setHas}/></div><span id="has-notes">{String(has)}</span></>};
    createRoot(document.getElementById('root')).render(<App/>);
  ` }));
} }] });
if (!built.success) throw new Error(built.logs.join('\n'));
const js = await built.outputs[0]!.text();
Bun.serve({ hostname:'127.0.0.1', port:41831, fetch(req) { return new URL(req.url).pathname==='/fixture.js' ? new Response(js,{headers:{'Content-Type':'text/javascript'}}) : new Response('<div id="root"></div><script type="module" src="/fixture.js"></script>',{headers:{'Content-Type':'text/html'}}); } });
console.log('Notes fixture: http://localhost:41831');
