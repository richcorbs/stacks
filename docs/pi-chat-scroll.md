# Pi chat bottom-follow regression

Run the controller/unit suite with `npm run test`. For actual browser layout:

```sh
npm ci
npx playwright install chromium webkit
npm run test:chat-scroll
```

The rendering suite starts its own Vite server on an available localhost port.
It mounts the production `PiGuiView`, and the production `CardChatView` inside
its card-dialog clipping hierarchy. Only the Pi session transport and Tauri IPC
are mocked; Markdown, timestamps, composer resizing, scrolling, and
ResizeObservers are real.

## Card #291 reproduction

Send these five lines while there is enough history to scroll:

```text
1.
2.
3.
4.
5.
```

Check both at the bottom and from an older reading position. In particular,
check with the Stacks window inactive while a response arrives. The old
controller performed **all** follow writes in `requestAnimationFrame`, so a
throttled/suspended animation-frame callback could leave newly committed
messages below the viewport even though following was enabled.

The browser suite deterministically withholds application animation-frame
callbacks to exercise that condition; it does not claim to simulate every OS
window-occlusion policy. Before the fix, the rendered five-line submit left a
186px bottom gap and a timestamp below the chat's clipping boundary. Following
now happens on the layout notification itself, with a coalesced animation frame
as a supplemental pass only. React transcript commits also notify the
controller in a layout effect, including timestamp-only message replacements.

Both Chromium and WebKit run the active/suspended-frame matrix in card and
workspace presentations: the exact report, plain multi-line text, wrapped
paragraphs, Markdown, and fenced code, including messages taller than the
viewport. Assertions cover composer collapse, streaming, delayed timestamps,
content-only layout changes, wrapping, viewport resize, reader scroll-away,
returning to bottom, sending from history, and anchored history prepends.
Timestamp/message bottoms are checked against the entire clipping chain, not
just the inner scrollport.
