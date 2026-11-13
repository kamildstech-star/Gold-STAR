import { beforeEach, describe, expect, it, vi } from "vitest";

/* ------------------------------------------------------------------ */
/* Mocks: no canvas and no gateway in a unit test                      */
/* ------------------------------------------------------------------ */

const ticketFileDataUrl = vi.fn();
const readFieldTicket = vi.fn();
const reportFieldTicketReadFailure = vi.fn();

vi.mock("./field-ticket-photo", () => ({
  ticketFileDataUrl: (f: Blob) => ticketFileDataUrl(f),
}));
vi.mock("./field-ticket-extract.functions", () => ({
  readFieldTicket: (arg: unknown) => readFieldTicket(arg),
  reportFieldTicketReadFailure: (arg: unknown) => reportFieldTicketReadFailure(arg),
}));

const { readPaperTicket } = await import("./field-ticket-read");

const sheet = new Blob(["not really a photo"], { type: "image/jpeg" });

const OPTS = {
  jobAddress: "36 Journal Square, Jersey City, NJ 07306",
  unitNumber: "",
  today: "2026-10-05",
  offline: false,
};

/** What the server function returns for Mark's sheet, already normalised. */
function serverOk(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    confidence: "high",
    uncertain: [],
    values: {
      job_address: "36 Journal Square, Jersey City, NJ 07306",
      unit_number: null,
      work_date: "2026-09-23",
      job_start_time: "09:00",
      job_end_time: "17:00",
      crew_chief_name: "Izzy / Allan",
      gsr_crew_size: 7,
      temp_crew_size: 10,
      job_types: [],
      scope_completed: ["demo"],
      materials_used: ["containment", "ppe", "rags", "trash_bags", "lay_flat_ducting"],
      equipment_left: { dehumidifier: 4, air_mover: 12, injector: 2 },
      trash_disposition: null,
      work_notes: null,
      job_completed: false,
      more_work_needed: true,
      ...over,
    },
  };
}

beforeEach(() => {
  ticketFileDataUrl.mockReset();
  readFieldTicket.mockReset();
  reportFieldTicketReadFailure.mockReset();
  reportFieldTicketReadFailure.mockResolvedValue({ logged: true });
  ticketFileDataUrl.mockResolvedValue({
    ok: true,
    bytes: 4,
    dataUrl: "data:image/webp;base64,AAAA",
    mime: "image/webp",
    fileName: "ticket.jpg",
  });
});

describe("readPaperTicket", () => {
  it("hands the form back filled in", async () => {
    readFieldTicket.mockResolvedValue(serverOk());
    const read = await readPaperTicket(sheet, OPTS);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.values.chief).toBe("Izzy / Allan");
    expect(read.values.gsr).toBe("7");
    expect(read.values.temp).toBe("10");
    expect(read.values.equip).toEqual({ dehumidifier: "4", air_mover: "12", injector: "2" });
    expect(read.values.completion).toBe("more");
    expect(read.confidence).toBe("high");
  });

  it("sends the file the way the server's schema wants it", async () => {
    readFieldTicket.mockResolvedValue(serverOk());
    await readPaperTicket(sheet, OPTS);
    expect(readFieldTicket).toHaveBeenCalledWith({
      data: {
        file_data_url: "data:image/webp;base64,AAAA",
        mime: "image/webp",
        file_name: "ticket.jpg",
      },
    });
  });

  it("uses the date it is handed, never the clock, when the sheet has none", async () => {
    readFieldTicket.mockResolvedValue(serverOk({ work_date: null }));
    const read = await readPaperTicket(sheet, OPTS);
    expect(read.ok && read.values.date).toBe("2026-10-05");
  });

  /* ---- every way this can fail ends at the manual form ---- */

  it("does not call the gateway at all with no signal", async () => {
    const read = await readPaperTicket(sheet, { ...OPTS, offline: true });
    expect(read.ok).toBe(false);
    expect(readFieldTicket).not.toHaveBeenCalled();
    expect(read.ok === false && read.retryable).toBe(true);
    expect(read.ok === false && read.error).toMatch(/by hand/i);
  });

  it("names a file it cannot shrink, and puts the attempt on record", async () => {
    ticketFileDataUrl.mockResolvedValue({
      ok: false,
      reason: "file_too_big",
      mime: "image/jpeg",
      bytes: 20_000_000,
      detail: "image/jpeg over the cap",
    });
    const read = await readPaperTicket(sheet, OPTS);
    expect(read).toEqual({
      ok: false,
      reason: "file_too_big",
      retryable: false,
      error: expect.stringContaining("(Code FT-SIZE)"),
    });
    expect(readFieldTicket).not.toHaveBeenCalled();
    expect(reportFieldTicketReadFailure).toHaveBeenCalledWith({
      data: expect.objectContaining({ reason: "file_too_big" }),
    });
  });

  it("names a picture the browser cannot open", async () => {
    ticketFileDataUrl.mockResolvedValue({
      ok: false,
      reason: "file_unusable",
      mime: "image/heic",
      bytes: 3,
      detail: "browser could not decode image/heic",
    });
    const read = await readPaperTicket(sheet, OPTS);
    expect(read.ok === false && read.reason).toBe("file_unusable");
    expect(read.ok === false && read.error).toContain("FT-FILE");
  });

  it("passes the server's own refusal through as it is — the server audited it", async () => {
    const refusal = {
      ok: false,
      reason: "limiter_unavailable",
      retryable: true,
      error: "The ticket reader could not check its usage limit just now. (Code FT-LIMIT)",
    };
    readFieldTicket.mockResolvedValue(refusal);
    const read = await readPaperTicket(sheet, OPTS);
    expect(read).toEqual(refusal);
    expect(reportFieldTicketReadFailure).not.toHaveBeenCalled();
  });

  it("still shows an older server's refusal that carries no reason", async () => {
    readFieldTicket.mockResolvedValue({
      ok: false,
      retryable: true,
      error: "Too many ticket reads. Please wait about 3 minute(s), or fill the ticket in by hand.",
    });
    const read = await readPaperTicket(sheet, OPTS);
    expect(read.ok === false && read.error).toContain("Too many ticket reads");
  });

  it("treats a request that never arrived as worth retrying, and reports it", async () => {
    readFieldTicket.mockRejectedValue(new TypeError("Failed to fetch"));
    const read = await readPaperTicket(sheet, OPTS);
    expect(read.ok === false && read.reason).toBe("unreachable");
    expect(read.ok === false && read.retryable).toBe(true);
    expect(reportFieldTicketReadFailure).toHaveBeenCalledWith({
      data: expect.objectContaining({ reason: "unreachable" }),
    });
  });

  it("tells a crew whose sign-in ran out to sign in, not to wait", async () => {
    readFieldTicket.mockRejectedValue(new Error("Unauthorized: Invalid token"));
    const read = await readPaperTicket(sheet, OPTS);
    expect(read.ok === false && read.reason).toBe("signed_out");
    expect(read.ok === false && read.error).toMatch(/sign in again/i);
    // The report would be refused for the same reason.
    expect(reportFieldTicketReadFailure).not.toHaveBeenCalled();
  });

  it("never lets a failed report change the read's own answer", async () => {
    readFieldTicket.mockRejectedValue(new TypeError("Failed to fetch"));
    reportFieldTicketReadFailure.mockRejectedValue(new TypeError("Failed to fetch"));
    const read = await readPaperTicket(sheet, OPTS);
    expect(read.ok === false && read.reason).toBe("unreachable");
  });

  it("never leaks the thrown error's text to the crew", async () => {
    readFieldTicket.mockRejectedValue(new Error("TypeError: undefined is not a function"));
    const read = await readPaperTicket(sheet, OPTS);
    expect(read.ok === false && read.error).not.toContain("TypeError");
  });

  it("carries the flagged fields through for the review step", async () => {
    readFieldTicket.mockResolvedValue({
      ...serverOk({ gsr_crew_size: null }),
      confidence: "low",
      uncertain: ["gsr_crew_size", "equip_air_mover"],
    });
    const read = await readPaperTicket(sheet, OPTS);
    expect(read.ok && read.uncertain).toEqual(
      expect.arrayContaining(["gsr_crew_size", "equip_air_mover"]),
    );
    expect(read.ok && read.confidence).toBe("low");
  });
});
