/**
 * The Field Camera screen, rendered: the mode tabs, the read-only View As
 * notice, the permission-denied fallback to the phone's own camera, and the
 * stamp preview. The camera, position and queue hooks are stubbed — their
 * logic is tested in src/lib/field-camera — so this pins what the crew sees.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  writesDisabled: false,
  stream: { kind: "live" } as { kind: string; reason?: string },
  jobs: null as unknown,
  torch: false,
}));

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ history: { back: vi.fn() } }),
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children: React.ReactNode }) => createElement("a", null, children),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (o: { queryKey: unknown[] }) => ({
    data: o.queryKey[0] === "field-camera-jobs" ? state.jobs : undefined,
    isLoading: false,
    error: null,
  }),
}));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));
vi.mock("@/components/app-context", () => ({
  useAppContext: () => ({
    userId: "u1",
    fullName: "Dov Levin",
    roles: ["crew"],
    writesDisabled: state.writesDisabled,
    writesDisabledReason: state.writesDisabled ? "Viewing as Sam (read-only)." : null,
    memberships: [{ location_id: "loc-1", role: "member" }],
    allLocations: [],
    regionMemberships: [],
  }),
}));
vi.mock("@/components/job-photos", () => ({ queueJobPhotoFiles: vi.fn() }));
vi.mock("@/lib/job-photos", () => ({ listJobPhotoFolders: vi.fn() }));
vi.mock("@/lib/labels", () => ({ fetchLabels: vi.fn() }));
vi.mock("@/lib/field-camera/upload", () => ({
  discardShot: vi.fn(),
  queueFieldShot: vi.fn(),
  setShotNote: vi.fn(),
  shotStatus: () => "uploaded",
}));
vi.mock("@/lib/field-camera/jobs", async (orig) => ({
  ...(await orig<typeof import("@/lib/field-camera/jobs")>()),
  loadCameraJobs: vi.fn(),
  serverCanAddPhotos: vi.fn(async () => null),
}));
vi.mock("./use-field-camera", () => ({
  useCameraStream: () => ({
    videoRef: { current: null },
    state: state.stream,
    caps: { torch: state.torch, zoom: null },
    torchOn: false,
    toggleTorch: vi.fn(),
    zoom: 1,
    digitalZoom: 1,
    choices: [
      { level: 1, label: "1x", hardware: false },
      { level: 2, label: "2", hardware: false },
    ],
    chooseZoom: vi.fn(),
    retry: vi.fn(),
  }),
  useDevicePosition: () => ({ fix: null, error: "denied" }),
  useDeviceAddress: () => null,
  useShotQueue: () => ({ pending: [], inFlight: {}, at: 0, refresh: vi.fn() }),
  useNow: () => new Date("2026-10-14T18:04:00Z"),
}));

import { FieldCamera } from "./field-camera";
import { CAMERA_MODES, modeDestination } from "@/lib/field-camera/modes";
import { CameraModeTabs } from "./mode-tabs";

const JOB = {
  id: "11111111-1111-4111-8111-111111111111",
  job_number: "24-1032",
  job_name: "Newark",
  address: "314 Troy Ave, New York NY 11213",
  customer_name: "Airbnb",
  account_id: null,
  location_id: "loc-1",
  loss_type_id: null,
  status: "in_progress",
  updated_at: "2026-10-14",
  lat: null,
  lon: null,
};

const render = (props: Parameters<typeof FieldCamera>[0] = {}) =>
  renderToStaticMarkup(createElement(FieldCamera, props));

beforeEach(() => {
  state.writesDisabled = false;
  state.stream = { kind: "live" };
  state.torch = false;
  state.jobs = { jobs: [JOB], albums: [], assignedIds: new Set(), memberAlbumIds: new Set() };
  try {
    globalThis.sessionStorage?.clear();
  } catch {
    /* node has none */
  }
});

describe("mode tabs", () => {
  it("shows Reports · Video · Photo · Clock · Checklist with Photo active", () => {
    const html = renderToStaticMarkup(
      createElement(CameraModeTabs, { jobId: JOB.id, onSelect: vi.fn() }),
    );
    const labels = [...html.matchAll(/data-mode="(\w+)"/g)].map((m) => m[1]);
    expect(labels).toEqual(["reports", "video", "photo", "clock", "checklist"]);
    expect(html).toMatch(/aria-selected="true"[^>]*data-mode="photo"/);
  });

  it("Video is disabled and says it is coming soon", () => {
    const html = renderToStaticMarkup(
      createElement(CameraModeTabs, { jobId: JOB.id, onSelect: vi.fn() }),
    );
    const video = html.match(/<button[^>]*data-mode="video"[^>]*>/)![0];
    expect(video).toContain("disabled");
    expect(video).toMatch(/coming soon/i);
    expect(CAMERA_MODES.find((m) => m.id === "video")!.comingSoon).toBeTruthy();
  });

  it("job modes wait for a job; Clock never does", () => {
    const html = renderToStaticMarkup(
      createElement(CameraModeTabs, { jobId: null, onSelect: vi.fn() }),
    );
    expect(html.match(/<button[^>]*data-mode="reports"[^>]*>/)![0]).toContain("disabled");
    expect(html.match(/<button[^>]*data-mode="checklist"[^>]*>/)![0]).toContain("disabled");
    expect(html.match(/<button[^>]*data-mode="clock"[^>]*>/)![0]).not.toContain("disabled");
  });

  it("links to the existing screens rather than new engines", () => {
    expect(modeDestination("clock", null)).toEqual({ to: "/timeclock" });
    expect(modeDestination("reports", "j")).toEqual({
      to: "/jobs/$id",
      jobId: "j",
      tab: "documents",
    });
    expect(modeDestination("checklist", "j")).toEqual({
      to: "/jobs/$id",
      jobId: "j",
      tab: "tasks",
    });
    expect(modeDestination("reports", null)).toBeNull();
    expect(modeDestination("video", "j")).toBeNull();
  });
});

describe("the camera screen", () => {
  it("View As is read-only: a notice, no viewfinder, no shutter", () => {
    state.writesDisabled = true;
    const html = render({ initialJobId: JOB.id });
    expect(html).toContain('data-testid="field-camera-readonly"');
    expect(html).toContain("Viewing as Sam");
    expect(html).not.toContain("<video");
    expect(html).not.toContain('data-testid="shutter"');
  });

  it("live: viewfinder, Verify Photos pill, shutter, Preview, Templates and the job chip", () => {
    const html = render({ initialJobId: JOB.id });
    expect(html).toContain("<video");
    expect(html).toContain("Verify Photos");
    expect(html).toContain('data-testid="shutter"');
    expect(html).toContain("Preview");
    expect(html).toContain("Templates");
    expect(html).toContain("24-1032 · Newark");
    expect(html).not.toContain('data-testid="camera-fallback"');
  });

  it("the flash button only appears when the lens has a torch", () => {
    expect(render({ initialJobId: JOB.id })).not.toContain("Turn flash on");
    state.torch = true;
    expect(render({ initialJobId: JOB.id })).toContain("Turn flash on");
  });

  it("the stamp preview prints time, date and — with GPS refused — the job's address", () => {
    const html = render({ initialJobId: JOB.id });
    const preview = html.match(/data-testid="stamp-preview"[\s\S]*?<\/div><\/div><\/div>/)![0];
    expect(preview).toMatch(/\d{1,2}:04 [AP]M/);
    expect(preview).toContain("10/14/2026 Wed");
    expect(preview).toContain("314 Troy Ave, New York NY 11213");
    expect(preview).toContain("Job 24-1032 · Newark");
    expect(preview).toContain("Dov Levin");
  });

  it("permission denied falls back to the phone's own camera and library", () => {
    state.stream = { kind: "failed", reason: "denied" };
    const html = render({ initialJobId: JOB.id });
    expect(html).toContain('data-testid="camera-fallback"');
    expect(html).toContain("Camera access is blocked for this app");
    expect(html).toContain("Take photo");
    expect(html).toContain("Choose photos");
    expect(html).toMatch(/<input[^>]*type="file"[^>]*accept="image\/\*"[^>]*capture="environment"/);
    expect(html).toMatch(/<input[^>]*type="file"[^>]*multiple/);
    // The shutter is there but cannot fire without a live stream.
    expect(html.match(/<button[^>]*data-testid="shutter"[^>]*>/)![0]).toContain("disabled");
  });

  it("an in-app browser with no camera API gets the same way out", () => {
    state.stream = { kind: "failed", reason: "unsupported" };
    const html = render({ initialJobId: JOB.id });
    expect(html).toContain("This browser can&#x27;t show a live camera");
    expect(html).toContain("Take photo");
  });

  it("a job the user cannot add photos to is never the job: no notice, the chip asks for one", () => {
    state.jobs = {
      jobs: [{ ...JOB, location_id: "loc-elsewhere" }],
      albums: [],
      assignedIds: new Set(),
      memberAlbumIds: new Set(),
    };
    const html = render({ initialJobId: JOB.id });
    expect(html).not.toContain("add photos here");
    expect(html).not.toContain(JOB.job_number);
    expect(html).toContain("Pick a job");
  });
});
