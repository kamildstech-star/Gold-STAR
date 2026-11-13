import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The Create proposal dialog sends for signature through the Documents
 * panel's own path — never a second e-signature integration. A static render
 * cannot press Send (and the dialog lives in a portal), so the wiring is
 * checked in the source, each check on its own fragment.
 */
const SOURCE = readFileSync(new URL("./proposal-dialog.tsx", import.meta.url), "utf8").replace(
  /\r\n/g,
  "\n",
);

function fn(name: string): string {
  const at = SOURCE.indexOf(`const ${name} = async`);
  expect(at, `${name} is gone`).toBeGreaterThan(-1);
  return SOURCE.slice(at, SOURCE.indexOf("\n  };\n", at));
}

describe("Send for e-signature", () => {
  it("is DocumentSendDialog's sequence: a document, a packet, the link, the email", () => {
    const send = fn("onSendForSignature");
    const order = [
      'fileDocument(id, "draft")',
      "createSendPacket(",
      "signUrl(packet.token)",
      'setProposalStatus(id, "sent", { documentId: docId })',
      "await send(",
      "announceEmailSend(",
    ].map((s) => send.indexOf(s));
    for (const at of order) expect(at).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(send).toContain("requireSignature: true");
  });

  it("files the document the way From template does", () => {
    const file = fn("fileDocument");
    expect(file).toContain('.from("documents")');
    expect(file).toContain("template_version_id");
    expect(file).toContain("rendered_body: body");
    expect(file).toContain('logDocumentEvent(data.id, "generated"');
  });

  it("names no e-signature vendor", () => {
    expect(SOURCE).not.toMatch(/ESIGN_|docuseal|opensign|docusign/i);
  });
});

describe("without e-signature", () => {
  it("Mark as sent files the document as sent and moves the proposal along", () => {
    const mark = fn("onMarkSent");
    expect(mark).toContain('fileDocument(id, "sent")');
    expect(mark).toContain('setProposalStatus(id, "sent", { documentId: docId })');
  });

  it("asks whether this person's email is connected, and says what to do when it is not", () => {
    expect(SOURCE).toContain("status({})");
    expect(SOURCE).toContain("emailQ.data?.configured === true");
    expect(SOURCE).toContain("use Download PDF, send it yourself, and press Mark as sent");
  });
});
