import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export type BankProvider = {
  orgId: string;
  orgName: string;
  orgCode: string;
  orgFullName?: string;
};

export type BanksConfig = {
  countryCode: string;
  currency: string;
  type: "e-wallet" | "bank";
  providers: BankProvider[];
};

const configRoot = join(__dirname, "../../../config/providers/payok/banks");

export function getPayokBanks(countryCode: string): BanksConfig {
  const path = join(configRoot, `${countryCode.toLowerCase()}.json`);
  const raw = readFileSync(path, "utf-8");
  return JSON.parse(raw) as BanksConfig;
}

export function getPayokProviderByCode(
  countryCode: string,
  orgCode: string
): BankProvider | undefined {
  const config = getPayokBanks(countryCode);
  return config.providers.find(
    (p) => p.orgCode.toUpperCase() === orgCode.toUpperCase()
  );
}
