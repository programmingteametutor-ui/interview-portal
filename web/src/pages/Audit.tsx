import { useState } from "react";
import { supabase, q } from "../lib/supabase";
import { useSession } from "../lib/session";
import { dateTime } from "../lib/format";
import { Card, PageHeader, Input, Table, Td, Loading, ErrorBox, Empty, Button, useAsync } from "../components/ui";

interface Row { id: number; at: string; actor_email: string | null; team_id: string | null; action: string; target_type: string | null; target_id: string | null; old_value: string | null; new_value: string | null; details: Record<string, unknown> | null }

/** Portal Action Log */
export function Audit() {
  const s = useSession();
  const [filter, setFilter] = useState("");
  const [limit, setLimit] = useState(200);
  const data = useAsync(async () => {
    let b = supabase.from("audit_log").select("*").order("at", { ascending: false }).limit(limit);
    if (!s.isSuper || s.role !== "SUPER_ADMIN") b = b.eq("team_id", s.teamId!);
    const f = filter.replace(/[,()%*:\\]/g, " ").trim();
    if (f) b = b.or(`action.ilike.*${f}*,actor_email.ilike.*${f}*,target_id.ilike.*${f}*`);
    return (await q(b)) as Row[];
  }, [s.teamId, filter, limit]);

  return (
    <>
      <PageHeader title="Audit Log" subtitle="Every approval, assignment, mapping and incentive change."
        actions={<Input placeholder="Filter action / email / target" value={filter} onChange={(e) => setFilter(e.target.value)} />} />
      <Card pad={false}>
        {data.loading ? <Loading /> : data.error ? <div className="p-4"><ErrorBox error={data.error} /></div> : !data.data?.length ? <Empty>No entries.</Empty> : (
          <Table head={["When", "Who", "Action", "Target", "Change", "Details"]} dense>
            {data.data.map((r) => (
              <tr key={r.id}>
                <Td className="whitespace-nowrap text-xs">{dateTime(r.at)}</Td>
                <Td className="text-xs">{r.actor_email}</Td>
                <Td className="text-xs font-medium">{r.action}</Td>
                <Td className="text-xs text-slate-500">{r.target_type} <span className="font-mono">{r.target_id}</span></Td>
                <Td className="text-xs">{r.old_value ?? ""}{r.old_value || r.new_value ? " → " : ""}{r.new_value ?? ""}</Td>
                <Td className="max-w-xs truncate text-xs text-slate-500" title={r.details ? JSON.stringify(r.details) : ""}>{r.details ? JSON.stringify(r.details) : ""}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {data.data?.length === limit && <div className="mt-3 text-center"><Button onClick={() => setLimit(limit + 300)}>Load more</Button></div>}
    </>
  );
}
