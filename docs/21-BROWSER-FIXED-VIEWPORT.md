# Fixed browser page and expanded preview

The browser starts at 1280×800 CSS viewport points. `RuntimeWeb` owns this logical
size; the existing `viewport` operation is its single explicit override. Panel
resize, thumbnail/expanded mode, Fit/100% and takeover do not reload or replace the
WebContents, CDP target, Session or partition. External browser profiles/cookies
are not imported.

The compact preview is read-only. Expand opens an in-app overlay; it does not
change controller. Human input still requires the existing takeover. Escape folds
from both the trusted UI and the native guest. A blocking application modal or
hidden panel hides the native surface immediately, even if a host operation owns
the queue. Superseded presentation intents cannot show it again.

Fit centers the native content rectangle with aspect-preserving scale, capped at
2×. Empty margins belong to Pult, not the page. 100% uses one UI CSS pixel per
logical page point and is enabled only when the full viewport fits. Observer 100%
also sets the image element's logical dimensions; Fit uses contain. Resize back to
a smaller area returns to Fit.

## Qualified Electron contract

Electron 45.2.3 is pinned by the shell package. One owner applies CDP desktop
`Emulation.setDeviceMetricsOverride` with the logical viewport, deviceScaleFactor
1 and presentation scale. There is no concurrent Electron emulation/zoom owner.
Hidden pages use a full-size render surface. Cross-page navigation retains the
logical viewport; explicit navigation reapplies the owner state.

The local causal probe found that raw CDP x/y fail at scale .5/.75 although native
mouse succeeds. The qualified adapter therefore converts **positions** from CSS
viewport points to presentation-scaled points exactly once for both press/release
and wheel origins, including AX-ref taps. Wheel deltas stay CSS distances. Neither
display DPR nor document scroll is multiplied/added. This is the tested Electron
45.2.3 adapter contract, not a general statement about all CDP implementations.
Requalify it when Electron changes.

Whole host operations and presentation changes share a bounded queue (16).
`runtime.host.begin` is rechecked inside that queue before executing a job, so
takeover/Stop while waiting cannot grant a late mutation. Logical coordinates do
not change when presentation scale changes. Native mouse uses Chromium's own
hit-testing; raster clicks are disabled for browser observer images.

## Local frames and isolation

The model screenshot route retains JPEG65 and its existing 530000-base64/900px
fallback budget. CSS viewport coverage is reported separately from JPEG raster
dimensions. Local expanded observer capture uses JPEG90, at most 2800000 base64
characters, on the same contents. Per-page single flight coalesces overlapping
local frame requests. Native human mode polls bounded metadata only. Hidden or
obstructed UI does not poll frames; UI ignores late replies after mode/session
changes. No images enter the durable journal. Guest page zoom is isolated at 1; presentation scaling is owned by Fit/100%, not browser page zoom.

The local preview IPC is trusted-application-only and verifies the current
session incarnation. Native show additionally checks controller and then rechecks
the current incarnation after that observational lookup, inside the presentation
queue. A recycled session name cannot lend its human controller to old contents.
Older shells without the local-preview capability show an update notice and do not enable the new native presentation/expand path. Existing sandbox, URL/redirect restrictions, popup/download/permission denial and
no-preload/no-Node policy remain.

## Verification

`shell/test/e2e/runtimeViewport.test.ts` runs actual Electron with local HTTP,
private daemon and fake provider at display DPR1/2. It covers fixed breakpoints,
same contents/nonce/form/scroll/cookie/load count; native and CDP four corners and
AX refs; resized native surface, CSS wheel distance; explicit viewport/navigation;
observer Fit/100% bounds; controller and Escape/modal behavior.
`runtimePresentation.test.ts` deterministically checks immediate modal hide behind
an owned operation, obsolete queued show, incarnation reuse and late generation
validation. Existing browser E2E covers privileged navigation, no IPC/Node/popups,
hidden screenshots and fresh storage after removed-session reuse.

Playwright's main-page screenshot excludes native child views; it must be labelled
renderer-only. Composited native evidence, when OS access permits, captures only
the controlled Electron window by its exact media-source window ID. No desktop
capture, screenshot montage, permission prompt or OS-setting change is used.

Only this local profile is qualified. External accounts, arbitrary installed
sites, IME breadth and other OS/display configurations are not inferred from the
fixture. Oversized local frames report a quality limit rather than silently
claiming thumbnail detail is full resolution.
