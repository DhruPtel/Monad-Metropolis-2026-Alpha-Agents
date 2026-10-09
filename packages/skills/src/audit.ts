import { ADDRESS_BOOK } from "@alpha-agents/domain";
import type { PackageIssue, SkillPackage } from "./packages.ts";

/**
 * The static audit rules that exist so far (P3-U7; the Bankr platform
 * mapping 2.6, D-102), run over every text file of a package. Each rule is a
 * set of patterns; a match is a Block or a Warn with the line it was found
 * on. The LLM review, the dynamic test and signing come with P6-U3 and P6-U4.
 */
interface Rule {
  readonly id: string;
  readonly severity: "block" | "warn";
  readonly what: string;
  readonly patterns: readonly RegExp[];
}

const RULES: readonly Rule[] = [
  {
    id: "S1",
    severity: "block",
    what: "shell or code execution",
    patterns: [
      /```\s*(bash|sh|shell|zsh|python|py|js|javascript|ts|typescript|node)\b/i,
      /\b(curl|wget|chmod|subprocess)\b/i,
      /\beval\(/,
      /\|\s*(sh|bash|python)\b/,
    ],
  },
  {
    id: "S2",
    severity: "block",
    what: "installs",
    patterns: [
      /\bnpm (i|install)\b/i,
      /\bnpx\b/,
      /\bpip install\b/i,
      /\bbrew install\b/i,
      /\bskills add\b/i,
      /\bmcpServers\b/,
    ],
  },
  {
    id: "S3",
    severity: "block",
    what: "remote instruction loading",
    patterns: [
      /https?:\/\/\S+\.md\b/i,
      /llms\.txt/i,
      /raw\.githubusercontent\.com/i,
      /\bre-fetch\b/i,
      /latest version of this skill/i,
    ],
  },
  {
    id: "S4",
    severity: "block",
    what: "credentials and secrets",
    patterns: [
      /PRIVATE_KEY/,
      /\bMNEMONIC\b/,
      /seed phrase/i,
      /API_KEY/,
      /_SECRET\b/,
      /\bBearer\b/,
      /X-API-Key/i,
      /\.env\b/,
      /process\.env/,
      /os\.environ/,
      /--private-key/,
    ],
  },
  {
    id: "S5",
    severity: "warn",
    what: "a network endpoint in the text",
    patterns: [/\bhttps?:\/\/[^\s)]+/i, /\bwww\.[a-z0-9-]+\.[a-z]{2,}/i],
  },
  {
    id: "S6",
    severity: "block",
    what: "signing",
    patterns: [
      /sign_message/,
      /personal_sign/,
      /signTypedData/,
      /eth_sign/,
      /\bpermit\(/,
      /transferWithAuthorization/,
      /sendTransaction/,
    ],
  },
  {
    id: "S7",
    severity: "block",
    what: "unlimited approvals or delegation",
    patterns: [
      /MAX_UINT/,
      /2\*\*256/,
      /type\(uint256\)\.max/,
      /setApprovalForAll/,
      /\bsession key\b/i,
      /\bautopay\b/i,
    ],
  },
  {
    id: "S8",
    severity: "block",
    what: "scheduling and state",
    patterns: [
      /\bevery \d+ (seconds|minutes|hours)\b/i,
      /\bheartbeat\b/i,
      /\bcron\b/i,
      /\bwebhook\b/i,
      /after every trade/i,
    ],
  },
  {
    id: "S9",
    severity: "block",
    what: "approval bypass",
    patterns: [
      /\s--?yes\b/,
      /\s-y\b/,
      /no confirmation/i,
      /without asking/i,
      /do not ask the (user|owner)/i,
      /auto-approve/i,
    ],
  },
  {
    id: "S10",
    severity: "block",
    what: "concealment",
    patterns: [
      /\bdo not tell\b/i,
      /\bnever tell\b/i,
      /\bdo not mention\b/i,
      /\bsilently\b/i,
      /\bhide (it|this|the)\b/i,
    ],
  },
  {
    id: "S11",
    severity: "warn",
    what: "override phrases",
    patterns: [
      /ignore (all|previous|prior)/i,
      /system prompt/i,
      /\byou are now\b/i,
      /developer mode/i,
      /highest priority/i,
    ],
  },
  {
    id: "S12",
    severity: "block",
    what: "hidden content",
    patterns: [
      new RegExp(
        `[${String.fromCharCode(0x200b)}-${String.fromCharCode(0x200f)}${String.fromCharCode(0x202a)}-${String.fromCharCode(0x202e)}${String.fromCharCode(0x2060)}-${String.fromCharCode(0x2069)}${String.fromCharCode(0xfeff)}]`,
      ),
      /<!--/,
      /[A-Za-z0-9+/]{200,}={0,2}/,
    ],
  },
  {
    id: "S14",
    severity: "block",
    what: "self-modification",
    patterns: [
      /edit this skill/i,
      /write to SKILL\.md/i,
      /update your memory/i,
      /create a skill/i,
      /skill_manage/,
    ],
  },
];

/** Every address the platform knows, any environment, lowercased. */
const KNOWN = new Set(
  Object.values(ADDRESS_BOOK)
    .flat()
    .flatMap((e) => {
      const a = (e as { address: string | null }).address;
      return a ? [a.toLowerCase()] : [];
    }),
);

const TEXT = /\.(md|json|ya?ml|csv)$/;

/** Runs the static rules (and S13 addresses, S15 publisher) over a package's text files. */
export function auditPackage(pkg: SkillPackage): PackageIssue[] {
  const issues: PackageIssue[] = [];
  for (const f of pkg.files) {
    if (!TEXT.test(f.path)) continue;
    const text = f.bytes.toString("utf8");
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      for (const r of RULES) {
        // The evals file is recorded data: it is checked for hidden content and addresses only.
        if (f.path.startsWith("evals/") && r.id !== "S12") continue;
        if (r.patterns.some((p) => p.test(line)))
          issues.push({
            rule: r.id,
            severity: r.severity,
            path: `${f.path}:${i + 1}`,
            message: r.what,
          });
      }
      // S13: a 32-byte hex value (a pool ID, a hash) is not an address; a 20-byte one must be known.
      for (const m of line.matchAll(/0x[0-9a-fA-F]{40,}/g)) {
        const hex = m[0];
        if (hex.length !== 42) continue;
        if (!KNOWN.has(hex.toLowerCase()) && !/^0x0{39}[0-9]$/.test(hex))
          issues.push({
            rule: "S13",
            severity: "warn",
            path: `${f.path}:${i + 1}`,
            message: `${hex} is not in the platform address book`,
          });
      }
    });
  }
  if (
    pkg.manifest.publisher.id !== "alpha-agents" &&
    /alpha agents|platform/i.test(pkg.manifest.name)
  )
    issues.push({
      rule: "S15",
      severity: "block",
      path: "skill.json:name",
      message: "the name claims the platform's brand",
    });
  return issues;
}
