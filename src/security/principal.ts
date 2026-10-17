export type MemberRole = "controller" | "approver" | "ap_clerk" | "auditor";

export interface Principal {
  accountId: string;
  userId: string;
  name: string;
  email: string;
  role: MemberRole;
  workspaceId: string;
  workspaceName: string;
  schemaName: string;
  owner: boolean;
  credential: "session" | "apiKey";
  tokenHash: string;
}
