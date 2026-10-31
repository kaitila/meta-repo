import { desc } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../../db/client";
import { items } from "../../db/schema";
import { body, json, parse, type Route } from "../context";

export const NewItem = z.object({ name: z.string().trim().min(1).max(200) }).strict();

export const itemRoutes: Route[] = [
  {
    method: "GET",
    path: "/api/items",
    mcp: { tool: "list_items", description: "List items, newest first." },
    async handler() {
      const rows = await getDb().select().from(items).orderBy(desc(items.createdAt)).limit(100);
      return json({ items: rows });
    },
  },
  {
    method: "POST",
    path: "/api/items",
    mcp: { tool: "create_item", description: "Create an item.", input: NewItem },
    async handler({ req }) {
      const input = parse(NewItem, await body(req));
      const [row] = await getDb().insert(items).values(input).returning();
      return json({ item: row }, 201);
    },
  },
];
