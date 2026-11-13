import { renderToStaticMarkup } from "react-dom/server";
import { User } from "lucide-react";
import { describe, expect, it } from "vitest";

import { DrawerField } from "@/components/detail-drawer";

describe("DrawerField", () => {
  it("renders read-only values as text instead of inert buttons", () => {
    const markup = renderToStaticMarkup(
      <DrawerField icon={User} label="Owner" display="Test Rep" readOnly />,
    );

    expect(markup).toContain("Test Rep");
    expect(markup).not.toContain("<button");
  });

  it("keeps editable values actionable", () => {
    const markup = renderToStaticMarkup(
      <DrawerField icon={User} label="Owner" value="Test Rep" onSave={() => undefined} />,
    );

    expect(markup).toContain("<button");
  });
});
