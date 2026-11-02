import { memo, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { PiMarkdown } from '../src/components/PiMarkdown';
import { PiSessionController, type ControllerDependencies } from '../src/pi/sessionController';

let notifications = 0;
let renders = 0;
const Agent = memo(function Agent({ controller }: { controller: PiSessionController }) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  renders++;
  return <section style={{ height: 250, overflow: 'auto' }}>
    <PiMarkdown>{snapshot.streamingText}</PiMarkdown>
    <pre>{snapshot.tools.map(tool => tool.partialText).join('\n')}</pre>
  </section>;
});
function App({ controllers }: { controllers: PiSessionController[] }) {
  const [input, setInput] = useState('');
  return <><input aria-label="Input probe" value={input} onChange={event => setInput(event.target.value)} />
    {controllers.map((controller, index) => <Agent key={index} controller={controller} />)}</>;
}

const root = createRoot(document.getElementById('root')!);
Object.assign(window, {
  async replay(agents: number) {
    notifications = renders = 0;
    const controllers = Array.from({ length: agents }, (_, index) => new PiSessionController({
      paneId: `replay-${index}`, workspaceId: 'replay', cwd: '/', projectId: 'replay', projectPath: '/',
    }, {
      invoke: async () => undefined, subscribe: async () => () => {}, events: { publish: () => {} },
      setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window),
    } as unknown as ControllerDependencies));
    let order = 0;
    const emit = (controller: PiSessionController, index: number, event: Parameters<typeof controller.project>[0]['event']) => controller.project({
      pane_id: `replay-${index}`, generation: 'replay', event_id: String(++order), event_order: order, event,
    });
    controllers.forEach((controller, index) => {
      controller.subscribe(() => notifications++);
      emit(controller, index, { type: 'tool_execution_start', toolCallId: 'tool', toolName: 'bash' });
    });
    root.render(<App controllers={controllers} />);
    await new Promise(resolve => setTimeout(resolve, 100));
    const started = performance.now();
    let expected = '';
    for (let index = 0; index < 320; index++) {
      const delta = `Streaming **line ${index}** with [safe link](https://example.com).\n\n`;
      expected += delta;
      controllers.forEach((controller, agent) => {
        emit(controller, agent, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta } });
        emit(controller, agent, { type: 'tool_execution_update', toolCallId: 'tool', partialResult: { content: [{ type: 'text', text: `progress ${index}` }] } });
      });
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    await new Promise(resolve => setTimeout(resolve, 50));
    const exact = controllers.every(controller => controller.getSnapshot().streamingText === expected && controller.getSnapshot().tools[0].partialText === 'progress 319');
    const result = { agents, notifications, renders, wallMs: Math.round(performance.now() - started), exact };
    controllers.forEach(controller => controller.delete(false));
    return result;
  },
});
