/**
 * The job picker offers only jobs this person can add photos to, using the
 * same rules the database applies on upload (`can_manage_project` on the
 * album; the projects insert policy when the job has no album yet).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import {
  canAddPhotos,
  jobChipLabel,
  matchesJob,
  rankCameraJobs,
  type CameraAlbum,
  type PhotoAccess,
} from "./jobs";

const LOC = "loc-brooklyn";
const OTHER = "loc-newark";

const access = (patch: Partial<PhotoAccess> = {}): PhotoAccess => ({
  roles: ["crew"],
  writesDisabled: false,
  memberAlbumIds: new Set(),
  locationRoles: new Map(),
  regionLocationIds: new Set(),
  ...patch,
});

const job = { id: "job-1", location_id: LOC };
const album: CameraAlbum = { id: "album-1", job_id: "job-1", location_id: LOC };

describe("who can add photos to a job", () => {
  it("owners, admins and devs always can", () => {
    for (const r of ["owner", "admin", "dev"] as const) {
      expect(canAddPhotos(job, [album], access({ roles: [r] }))).toBe(true);
    }
  });

  it("nobody can while viewing as someone else (read-only)", () => {
    expect(canAddPhotos(job, [album], access({ roles: ["admin"], writesDisabled: true }))).toBe(
      false,
    );
  });

  it("a member of the job's album can", () => {
    expect(canAddPhotos(job, [album], access({ memberAlbumIds: new Set(["album-1"]) }))).toBe(true);
  });

  it("an office manager or office staff at the album's location can", () => {
    for (const role of ["manager", "office"]) {
      expect(canAddPhotos(job, [album], access({ locationRoles: new Map([[LOC, role]]) }))).toBe(
        true,
      );
    }
  });

  it("an ordinary office member who is not on the album cannot — the upload would be refused", () => {
    expect(canAddPhotos(job, [album], access({ locationRoles: new Map([[LOC, "member"]]) }))).toBe(
      false,
    );
  });

  it("a manager of a different office cannot", () => {
    expect(
      canAddPhotos(job, [album], access({ locationRoles: new Map([[OTHER, "manager"]]) })),
    ).toBe(false);
  });

  it("with no album yet, any member of the job's office (or its region) can start one", () => {
    expect(canAddPhotos(job, [], access({ locationRoles: new Map([[LOC, "member"]]) }))).toBe(true);
    expect(canAddPhotos(job, [], access({ regionLocationIds: new Set([LOC]) }))).toBe(true);
    expect(canAddPhotos(job, [], access({ locationRoles: new Map([[OTHER, "manager"]]) }))).toBe(
      false,
    );
  });

  it("only this job's albums count", () => {
    const elsewhere: CameraAlbum = { id: "album-9", job_id: "job-9", location_id: LOC };
    expect(canAddPhotos(job, [elsewhere], access({ memberAlbumIds: new Set(["album-9"]) }))).toBe(
      false,
    );
  });

  it("filters a picker list down to the jobs that would accept the photo", () => {
    const jobs = [
      { id: "a", location_id: LOC },
      { id: "b", location_id: OTHER },
      { id: "c", location_id: LOC },
    ];
    const albums: CameraAlbum[] = [{ id: "alb-c", job_id: "c", location_id: LOC }];
    const me = access({ locationRoles: new Map([[LOC, "member"]]) });
    expect(jobs.filter((j) => canAddPhotos(j, albums, me)).map((j) => j.id)).toEqual(["a"]);
  });
});

describe("picker order and search", () => {
  const J = (id: string, updated: string) => ({ id, updated_at: updated });
  const list = [
    J("old", "2026-10-01"),
    J("new", "2026-10-13"),
    J("mine", "2026-09-01"),
    J("pin", "2026-08-01"),
  ];

  it("pinned first, then picked this session, then assigned, then newest", () => {
    expect(rankCameraJobs(list, new Set(["mine"]), "pin").map((j) => j.id)).toEqual([
      "pin",
      "mine",
      "new",
      "old",
    ]);
    expect(rankCameraJobs(list, new Set(["mine"]), null, ["old"]).map((j) => j.id)).toEqual([
      "old",
      "mine",
      "new",
      "pin",
    ]);
  });

  it("matches every word against number, name, customer and address", () => {
    const j = {
      job_number: "24-1032",
      job_name: "Newark",
      customer_name: "Airbnb",
      address: "314 Troy Ave, Brooklyn",
    };
    expect(matchesJob(j, "")).toBe(true);
    expect(matchesJob(j, "troy 1032")).toBe(true);
    expect(matchesJob(j, "AIRBNB")).toBe(true);
    expect(matchesJob(j, "troy queens")).toBe(false);
  });

  it("labels the chip with the number and a short name", () => {
    expect(jobChipLabel({ job_number: "24-1032", job_name: "Newark", address: "x" })).toBe(
      "24-1032 · Newark",
    );
    expect(
      jobChipLabel({ job_number: "24-1032", job_name: null, address: "314 Troy Ave, Brooklyn" }),
    ).toBe("24-1032 · 314 Troy Ave");
  });
});
