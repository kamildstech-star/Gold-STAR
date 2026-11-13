// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/*
 * 13 Nov (owner): a field a role may not edit is plain read-only text — not a
 * disabled button with a "You do not have access to edit this" tooltip.
 */

vi.mock("@/components/job-inline-field", () => ({
  useSectionEdit: () => false,
  useSectionStage: () => null,
}));

import { InlineField } from "./inline-field";
import { RowField } from "./row-inline-field";

describe("read-only fields are plain text", () => {
  it("RowField: no button, no access tooltip when read-only", () => {
    const html = renderToStaticMarkup(
      createElement(RowField, { value: "Kitchen", onSave: () => undefined, readOnly: true }),
    );
    expect(html).toContain("Kitchen");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("disabled");
    expect(html).not.toMatch(/access/i);
  });

  it("RowField: still click-to-edit when editable", () => {
    const html = renderToStaticMarkup(
      createElement(RowField, { value: "Kitchen", onSave: () => undefined }),
    );
    expect(html).toContain("<button");
    expect(html).toContain("Click to edit");
  });

  it("InlineField: no button and no disabled control when it may not be edited", () => {
    const html = renderToStaticMarkup(
      createElement(InlineField, {
        label: "Stage",
        value: "Active",
        onSave: async () => undefined,
        canEdit: false,
      }),
    );
    expect(html).toContain("Active");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("disabled");
    expect(html).not.toContain("title=");
  });

  it("InlineField: a button when it may be edited", () => {
    const html = renderToStaticMarkup(
      createElement(InlineField, {
        label: "Stage",
        value: "Active",
        onSave: async () => undefined,
        canEdit: true,
      }),
    );
    expect(html).toContain("<button");
    expect(html).toContain("Edit Stage");
  });
});
