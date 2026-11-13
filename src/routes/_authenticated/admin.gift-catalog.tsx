import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { useAppContext } from "@/components/app-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { LoadError } from "@/components/ui-density";
import { supabase } from "@/integrations/supabase/client";
import { toastDbError } from "@/lib/db-errors";
import { fmtCents } from "@/lib/lifecycle";
import { listCatalog } from "@/lib/gifts";

export const Route = createFileRoute("/_authenticated/admin/gift-catalog")({
  head: () => ({
    meta: [
      { title: "Gift catalog — Recovery Hub" },
      {
        name: "description",
        content:
          "Items, vendors and unit costs used by farming gift campaigns. Configuration, not daily work.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: GiftCatalogPage,
});

function GiftCatalogPage() {
  const app = useAppContext();
  const qc = useQueryClient();
  const [name, setName] = React.useState("");
  const [desc, setDesc] = React.useState("");
  const [cost, setCost] = React.useState("");

  const catalogQ = useQuery({ queryKey: ["gift-catalog"], queryFn: () => listCatalog() });

  const add = useMutation({
    mutationFn: async () => {
      if (name.trim().length < 2) throw new Error("Name the item.");
      const dollars = Number(cost);
      if (!Number.isFinite(dollars) || dollars < 0) throw new Error("Enter a unit cost.");
      const { error } = await supabase.from("gift_catalog").insert({
        name: name.trim(),
        description: desc.trim() || null,
        unit_cost_cents: Math.round(dollars * 100),
        active: true,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Item added");
      setName("");
      setDesc("");
      setCost("");
      void qc.invalidateQueries({ queryKey: ["gift-catalog"] });
    },
    onError: (e) => toastDbError(e, { action: "Add catalog item" }),
  });

  const toggle = useMutation({
    mutationFn: async (item: { id: string; active: boolean }) => {
      const { error } = await supabase
        .from("gift_catalog")
        .update({ active: !item.active })
        .eq("id", item.id);
      if (error) throw error;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["gift-catalog"] }),
    onError: (e) => toastDbError(e, { action: "Update catalog item" }),
  });

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Items, sizes, vendors and unit costs. Campaigns are built in Active Clients → Campaigns;
        this is the list they pick from.
      </p>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Add an item</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <Label className="text-xs">Name</Label>
              <Input
                className="w-[200px]"
                value={name}
                placeholder="Fruit basket — large"
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div>
              <Label className="text-xs">Vendor / notes</Label>
              <Input className="w-[240px]" value={desc} onChange={(e) => setDesc(e.target.value)} />
            </div>
            <div>
              <Label className="text-xs">Unit cost (USD)</Label>
              <NumberInput
                className="w-[130px]"
                decimals={2}
                value={cost}
                onValueChange={(_, clean) => setCost(clean)}
              />
            </div>
            <Button
              size="sm"
              disabled={app.writesDisabled || add.isPending}
              onClick={() => add.mutate()}
            >
              Add
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Catalog</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {catalogQ.isError ? (
            <div className="p-3">
              <LoadError
                what="gift catalog"
                error={catalogQ.error}
                onRetry={() => void catalogQ.refetch()}
              />
            </div>
          ) : (catalogQ.data ?? []).length === 0 ? (
            <p className="p-3 text-xs text-muted-foreground">
              No items yet. Add the things you actually send — baskets, seasonal boxes, branded
              items — with their real unit cost so campaign spend rolls up correctly.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead>Vendor / notes</TableHead>
                  <TableHead>Unit cost</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {(catalogQ.data ?? []).map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="text-[12.5px] font-medium">{c.name}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {c.description ?? "—"}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {fmtCents(c.unit_cost_cents)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={c.active ? "secondary" : "outline"}>
                        {c.active ? "Active" : "Retired"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 px-2 text-[11px]"
                        disabled={app.writesDisabled}
                        onClick={() => toggle.mutate({ id: c.id, active: c.active })}
                      >
                        {c.active ? "Retire" : "Restore"}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
