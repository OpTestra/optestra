import { createHash } from "node:crypto";

// In-memory data. Ids come from counters and dates from a fixed clock, so the
// same requests always produce the same data (and the same pages).

export const TODAY = "2026-01-15";
export const TRIAL_DAYS = 14;

export interface Plan {
  id: string;
  name: string;
  priceCents: number;
  features: string[];
}

export const PLANS: readonly Plan[] = [
  { id: "starter", name: "Starter", priceCents: 900, features: ["1 project", "Email support"] },
  {
    id: "pro",
    name: "Pro",
    priceCents: 2900,
    features: ["Unlimited projects", "Priority support", "Order exports"],
  },
  {
    id: "team",
    name: "Team",
    priceCents: 7900,
    features: ["Everything in Pro", "10 team members", "Single sign-on"],
  },
];

export function findPlan(id: string | null | undefined): Plan | undefined {
  return PLANS.find((plan) => plan.id === id);
}

export interface User {
  id: number;
  email: string;
  password: string;
  name: string;
  timezone: string;
  verified: boolean;
  subscription: { planId: string; trialEndsOn: string } | null;
  avatar: { type: string; data: Buffer; version: number } | null;
}

export interface Project {
  id: number;
  userId: number;
  name: string;
  createdOn: string;
}

export interface Order {
  number: string;
  userId: number;
  date: string;
  status: "Paid" | "Refunded" | "Pending";
  totalCents: number;
}

export interface Email {
  to: string;
  subject: string;
  text: string;
}

export const TIMEZONES = ["UTC", "Europe/London", "America/New_York", "Asia/Tokyo"] as const;

export const DEFAULT_USER = {
  email: "ada@example.com",
  password: "shop-demo-pass",
  name: "Ada Lovelace",
} as const;

/** Six orders per seeded user; one is refunded and hidden by default. */
const ORDER_ROWS: ReadonlyArray<Omit<Order, "userId">> = [
  { number: "A-1001", date: "2025-12-02", status: "Paid", totalCents: 4500 },
  { number: "A-1002", date: "2025-12-09", status: "Paid", totalCents: 890 },
  { number: "A-1003", date: "2025-12-17", status: "Refunded", totalCents: 21000 },
  { number: "A-1004", date: "2025-12-28", status: "Paid", totalCents: 15000 },
  { number: "A-1005", date: "2026-01-06", status: "Pending", totalCents: 3299 },
  { number: "A-1006", date: "2026-01-12", status: "Paid", totalCents: 1200 },
];

export function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** The code in the verification email: derived from the address, never random. */
export function verificationCode(email: string): string {
  const hash = createHash("sha256").update(email.toLowerCase()).digest();
  return String(hash.readUInt32BE(0) % 1_000_000).padStart(6, "0");
}

export interface SeedInput {
  email?: string;
  password?: string;
  name?: string;
  trial?: string;
  projects?: string[];
}

export class Store {
  users: User[] = [];
  projects: Project[] = [];
  orders: Order[] = [];
  outbox: Email[] = [];
  sessions = new Map<string, number>();
  cardTokens = new Map<string, string>();
  private next = { user: 1, project: 1, session: 1, token: 1 };

  reset(): void {
    this.users = [];
    this.projects = [];
    this.orders = [];
    this.outbox = [];
    this.sessions.clear();
    this.cardTokens.clear();
    this.next = { user: 1, project: 1, session: 1, token: 1 };
  }

  userByEmail(email: string): User | undefined {
    const wanted = email.trim().toLowerCase();
    return this.users.find((user) => user.email === wanted);
  }

  userBySession(sessionId: string | undefined): User | undefined {
    const userId = sessionId ? this.sessions.get(sessionId) : undefined;
    return this.users.find((user) => user.id === userId);
  }

  createUser(email: string, password: string, name = ""): User {
    const user: User = {
      id: this.next.user++,
      email: email.trim().toLowerCase(),
      password,
      name,
      timezone: "UTC",
      verified: false,
      subscription: null,
      avatar: null,
    };
    this.users.push(user);
    return user;
  }

  deleteUser(user: User): void {
    this.users = this.users.filter((u) => u.id !== user.id);
    this.projects = this.projects.filter((p) => p.userId !== user.id);
    this.orders = this.orders.filter((o) => o.userId !== user.id);
    for (const [id, userId] of this.sessions) if (userId === user.id) this.sessions.delete(id);
  }

  startSession(user: User): string {
    const id = `sess-${this.next.session++}`;
    this.sessions.set(id, user.id);
    return id;
  }

  startTrial(user: User, planId: string): void {
    user.subscription = { planId, trialEndsOn: addDays(TODAY, TRIAL_DAYS) };
  }

  addProject(user: User, name: string): Project {
    const id = this.next.project++;
    return { id, userId: user.id, name, createdOn: addDays(TODAY, 0) };
  }

  saveProject(project: Project): void {
    this.projects.push(project);
  }

  projectsOf(user: User): Project[] {
    return this.projects.filter((project) => project.userId === user.id);
  }

  ordersOf(user: User): Order[] {
    return this.orders.filter((order) => order.userId === user.id);
  }

  sendEmail(email: Email): void {
    this.outbox.push(email);
  }

  tokenizeCard(cardNumber: string): string {
    const token = `tok_${this.next.token++}`;
    this.cardTokens.set(token, cardNumber);
    return token;
  }

  /** A verified user with orders, optionally on a trial and with projects. */
  seed(input: SeedInput = {}): User {
    const email = input.email ?? DEFAULT_USER.email;
    const existing = this.userByEmail(email);
    if (existing) this.deleteUser(existing);
    const user = this.createUser(
      email,
      input.password ?? DEFAULT_USER.password,
      input.name ?? DEFAULT_USER.name,
    );
    user.verified = true;
    if (input.trial) this.startTrial(user, input.trial);
    for (const name of input.projects ?? []) this.saveProject(this.addProject(user, name));
    for (const row of ORDER_ROWS) this.orders.push({ ...row, userId: user.id });
    return user;
  }
}
