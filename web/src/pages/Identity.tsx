import { useMemo, useState } from "react";
import { supabase, q, rpc, fetchAll } from "../lib/supabase";
import { useSession } from "../lib/session";
import { addDays, todayWorkDate, shortDate } from "../lib/format";
import { Button, Card, PageHeader, Input, Table, Td, Loading, ErrorBox, Empty, Tabs, Select, Modal, Field, Badge, useAsync, useAction } from "../components/ui";
import { suggestClientAliases, type AliasSuggestion } from "@shared/recovery";

type Kind = "candidate" | "client" | "suggestions";
interface Unresolved { name: string; count: number; last: string }
interface Master { id: string; canonical_name: string }

/** Candidate/Client identity mapping (PORTALIDENTITYMAPPING.gs) */
export function Identity() {
  const s = useSession();
  const [kind, setKind] = useState<Kind>("candidate");
  const [days, setDays] = useState(30);
  const [target, setTarget] = useState<Unresolved | null>(null);
  const [search, setSearch] = useState("");
  const [choice, setChoice] = useState<string>("");
  const [newName, setNewName] = useState("");
  const { busy, run } = useAction();

  const data = useAsync(async () => {
    if (kind === "suggestions") return [];
    const col = kind === "candidate" ? "candidate" : "client";
    const rows = await fetchAll<{ name: string | null; work_date: string }>((a, b) =>
      supabase.from("interviews").select(`name:${col}_name,work_date`).eq("team_id", s.teamId!)
        .is(`${col}_id`, null).not(`${col}_name`, "is", null).gte("work_date", addDays(todayWorkDate(), -days)).range(a, b));
    const m = new Map<string, Unresolved>();
    rows.forEach((r) => {
      if (!r.name) return;
      const k = r.name.trim().toLowerCase();
      const cur = m.get(k) ?? { name: r.name.trim(), count: 0, last: r.work_date };
      cur.count++; if (r.work_date > cur.last) cur.last = r.work_date;
      m.set(k, cur);
    });
    return [...m.values()].sort((a, b) => b.last.localeCompare(a.last) || b.count - a.count);
  }, [s.teamId, kind, days]);

  const sugg = useAsync(async () => {
    if (kind !== "suggestions") return [] as AliasSuggestion[];
    const rows = await fetchAll<{ candidate_name: string | null; candidate_id: string | null; client_name: string | null; client_id: string | null; cli: { canonical_name: string } | null }>((a, b) =>
      supabase.from("interviews").select("candidate_name,candidate_id,client_name,client_id,cli:clients(canonical_name)")
        .eq("team_id", s.teamId!).gte("work_date", addDays(todayWorkDate(), -days)).range(a, b));
    return suggestClientAliases(rows.map((r) => ({ ...r, client_canonical: r.cli?.canonical_name ?? null })));
  }, [s.teamId, kind, days]);

  const accept = (g: AliasSuggestion, swap = false) => run("s" + g.alias, async () => {
    const official = swap ? g.alias : g.official, alias = swap ? g.official : g.alias;
    let id = swap ? null : g.official_client_id;
    if (!id) id = await rpc<string>("map_identity", { p_kind: "client", p_alias: official, p_target_id: null, p_new_canonical: official });
    await rpc("map_identity", { p_kind: "client", p_alias: alias, p_target_id: id });
    sugg.reload();
  }, `“${swap ? g.official : g.alias}” now maps to “${swap ? g.alias : g.official}”`);

  const matches = useAsync(async () => {
    if (kind === "suggestions") return [] as Master[];
    const term = search.trim();
    if (term.length < 2) return [] as Master[];
    return (await q(supabase.from(kind === "candidate" ? "candidates" : "clients").select("id,canonical_name")
      .ilike("canonical_name", `%${term.replace(/[%_]/g, "")}%`).order("canonical_name").limit(15))) as Master[];
  }, [search, kind]);

  const open = (u: Unresolved) => {
    setTarget(u); setChoice(""); setNewName(u.name);
    setSearch(u.name.split(" ").slice(0, 2).join(" "));
  };
  const save = () => run("map", async () => {
    await rpc("map_identity", { p_kind: kind, p_alias: target!.name, p_target_id: choice === "__new" ? null : choice, p_new_canonical: choice === "__new" ? newName : null });
    setTarget(null); data.reload();
  }, "Mapped — matching calls updated");

  const list = useMemo(() => data.data ?? [], [data.data]);

  return (
    <>
      <PageHeader title="Identity Mapping"
        subtitle="Link names as written in interview lines to one master candidate / client, so promotions are matched across rounds."
        actions={<Select value={days} onChange={(e) => setDays(Number(e.target.value))}>{[7, 30, 90, 365].map((d) => <option key={d} value={d}>Last {d} days</option>)}</Select>} />
      <Tabs value={kind} onChange={setKind} items={[{ id: "candidate", label: "Candidates" }, { id: "client", label: "Clients" }, { id: "suggestions", label: "Suggested client aliases" }]} />
      {kind === "suggestions" ? (
        <Card pad={false} title="Same candidate, client written two ways" actions={<span className="text-xs text-slate-500">Accepting links the spelling to one master client; the next incentive scan picks up any promotion it was hiding.</span>}>
          {sugg.loading ? <Loading /> : sugg.error ? <div className="p-4"><ErrorBox error={sugg.error} /></div> : !sugg.data?.length ? <Empty>No suggestions.</Empty> : (
            <Table head={["Written as", "", "Map to", "Seen with", "Match", ""]} dense>
              {sugg.data.map((g) => (
                <tr key={g.alias + g.official}>
                  <Td className="font-medium">{g.alias} <span className="text-xs text-slate-400">({g.calls})</span></Td><Td className="text-slate-400">→</Td>
                  <Td>{g.official} {g.official_client_id ? <span className="text-xs text-slate-400">{g.official_client_id}</span> : <Badge v="pending">new master</Badge>}</Td>
                  <Td className="text-xs text-slate-500">{g.candidate}</Td><Td className="tabular">{g.score}%</Td>
                  <Td className="text-right whitespace-nowrap">
                    <Button size="sm" variant="ghost" busy={busy === "s" + g.alias} onClick={() => accept(g, true)}>Use other spelling</Button>
                    <Button size="sm" busy={busy === "s" + g.alias} onClick={() => accept(g)}>Accept</Button>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      ) : (
      <Card pad={false} title={`Unmapped ${kind} names`} actions={<span className="text-xs text-slate-500">{list.length} names</span>}>
        {data.loading ? <Loading /> : data.error ? <div className="p-4"><ErrorBox error={data.error} /></div> : list.length === 0 ? <Empty>Everything is mapped. 🎉</Empty> : (
          <Table head={["Name as written", "Calls", "Last seen", ""]} dense>
            {list.slice(0, 300).map((u) => (
              <tr key={u.name}>
                <Td className="font-medium">{u.name}</Td><Td className="tabular">{u.count}</Td><Td>{shortDate(u.last)}</Td>
                <Td className="text-right"><Button size="sm" onClick={() => open(u)}>Map…</Button></Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      )}

      <Modal open={!!target} onClose={() => setTarget(null)} title={`Map “${target?.name}”`} wide
        footer={<><Button onClick={() => setTarget(null)}>Cancel</Button><Button variant="primary" disabled={!choice || (choice === "__new" && !newName.trim())} busy={busy === "map"} onClick={save}>Save mapping</Button></>}>
        <Field label={`Search the ${kind} master`}><Input value={search} onChange={(e) => setSearch(e.target.value)} className="w-full" autoFocus /></Field>
        <div className="max-h-64 space-y-1 overflow-y-auto">
          {matches.loading ? <Loading /> : (matches.data ?? []).map((m) => (
            <label key={m.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-slate-50">
              <input type="radio" name="pick" checked={choice === m.id} onChange={() => setChoice(m.id)} />
              <span>{m.canonical_name}</span><span className="text-xs text-slate-400">{m.id}</span>
            </label>
          ))}
          <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-slate-50">
            <input type="radio" name="pick" checked={choice === "__new"} onChange={() => setChoice("__new")} />
            <span>Create a new {kind}:</span>
            <Input value={newName} onChange={(e) => setNewName(e.target.value)} onFocus={() => setChoice("__new")} className="flex-1 py-1" />
          </label>
        </div>
      </Modal>
    </>
  );
}
