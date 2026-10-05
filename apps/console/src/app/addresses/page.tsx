import { ENVIRONMENT_IDS, ENVIRONMENTS } from "@alpha-agents/config";
import { ADDRESS_BOOK } from "@alpha-agents/domain";
import {
  AddressDisplay,
  Badge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@alpha-agents/ui";
import { PanelHeader } from "@/components/panel-header";

export default function AddressBookPage() {
  return (
    <div className="flex flex-col gap-6">
      <PanelHeader
        title="Address book"
        description="Every external contract the plan names and every contract we deploy, per environment, from packages/domain. Only verified entries can be used for signing."
      />
      <Tabs defaultValue="local">
        <TabsList aria-label="Environment">
          {ENVIRONMENT_IDS.map((id) => (
            <TabsTrigger key={id} value={id}>
              {id} ({ENVIRONMENTS[id].label})
            </TabsTrigger>
          ))}
        </TabsList>
        {ENVIRONMENT_IDS.map((id) => {
          const entries = ADDRESS_BOOK[id];
          const verified = entries.filter((e) => e.status === "verified").length;
          return (
            <TabsContent key={id} value={id} className="flex flex-col gap-3">
              <p className="text-sm text-foreground-muted">
                <span className="numeric text-foreground">{verified}</span> of{" "}
                <span className="numeric text-foreground">{entries.length}</span> entries verified
                on chain <span className="numeric">{ENVIRONMENTS[id].chainId}</span>.
              </p>
              <Table label={`Address book, ${id}`}>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">Entry</TableHead>
                    <TableHead scope="col">Address</TableHead>
                    <TableHead scope="col">Status</TableHead>
                    <TableHead scope="col">Open question</TableHead>
                    <TableHead scope="col">Source</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {entries.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell>
                        <span className="flex flex-col">
                          <span className="font-medium">{e.label}</span>
                          <span className="text-xs text-foreground-muted">{e.note}</span>
                        </span>
                      </TableCell>
                      <TableCell>
                        {e.address ? (
                          <AddressDisplay address={e.address} label={e.label} />
                        ) : (
                          <span className="text-xs text-foreground-muted">No known address</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge tone={e.status === "verified" ? "positive" : "detail"}>
                          {e.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="numeric text-xs">{e.openQuestion ?? "none"}</TableCell>
                      <TableCell className="text-xs text-foreground-muted">{e.source}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TabsContent>
          );
        })}
      </Tabs>
    </div>
  );
}
