import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { query } from "../db.js";
import { signToken } from "../jwt.js";

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  password_hash: string;
  subscription_tier: string;
}

function toProfile(u: UserRow) {
  return {
    id: u.id,
    email: u.email,
    name: u.name ?? "",
    subscriptionTier: (u.subscription_tier || "FREE").toUpperCase(),
  };
}

const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Interim email/password auth (public routes). Clerk is the eventual target. */
export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/auth/register", async (req, reply) => {
    const { name, email, password } = (req.body ?? {}) as {
      name?: string;
      email?: string;
      password?: string;
    };

    const errors: { field: string; message: string }[] = [];
    if (!name?.trim()) errors.push({ field: "name", message: "Name is required" });
    if (!email || !emailRe.test(email)) errors.push({ field: "email", message: "Valid email is required" });
    if (!password || password.length < 8)
      errors.push({ field: "password", message: "Password must be at least 8 characters" });
    if (errors.length) return reply.code(400).send({ message: "Validation failed", errors });

    const existing = await query<{ id: string }>("SELECT id FROM users WHERE email=$1", [email]);
    if (existing[0]) {
      return reply.code(409).send({
        message: "Email already registered",
        errors: [{ field: "email", message: "Email already registered" }],
      });
    }

    const hash = await bcrypt.hash(password!, 10);
    const rows = await query<UserRow>(
      `INSERT INTO users (email, password_hash, name) VALUES ($1,$2,$3)
       RETURNING id, email, name, password_hash, subscription_tier`,
      [email, hash, name],
    );
    const user = toProfile(rows[0]);
    return reply.code(201).send({ token: signToken(user.id), user });
  });

  app.post("/api/auth/login", async (req, reply) => {
    const { email, password } = (req.body ?? {}) as { email?: string; password?: string };
    if (!email || !password) {
      return reply.code(400).send({ message: "Email and password are required" });
    }
    const rows = await query<UserRow>(
      "SELECT id, email, name, password_hash, subscription_tier FROM users WHERE email=$1",
      [email],
    );
    const u = rows[0];
    if (!u || !(await bcrypt.compare(password, u.password_hash))) {
      return reply.code(401).send({ message: "Invalid email or password" });
    }
    const user = toProfile(u);
    return reply.send({ token: signToken(user.id), user });
  });
}
