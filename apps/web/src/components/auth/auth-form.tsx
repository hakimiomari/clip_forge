"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { motion } from "framer-motion";
import { Clapperboard } from "lucide-react";
import type { AuthUser } from "@clipforge/shared-types";
import { api, ApiError } from "@/lib/api";
import { useAuthStore } from "@/lib/auth-store";
import { Button } from "@/components/ui/button";
import { Input, Label, FieldError } from "@/components/ui/input";
import { Card } from "@/components/ui/card";

const registerSchema = z.object({
  name: z.string().max(100).optional(),
  email: z.string().email("Enter a valid email"),
  password: z.string().min(8, "At least 8 characters"),
});

const loginSchema = z.object({
  name: z.string().optional(),
  email: z.string().email("Enter a valid email"),
  password: z.string().min(1, "Password is required"),
});

type FormValues = z.infer<typeof registerSchema>;

export function AuthForm({ mode }: { mode: "login" | "register" }) {
  const router = useRouter();
  const setUser = useAuthStore((s) => s.setUser);
  const [serverError, setServerError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(mode === "register" ? registerSchema : loginSchema),
  });

  const onSubmit = async (values: FormValues) => {
    setServerError(null);
    try {
      const { user } = await api<{ user: AuthUser }>(`/auth/${mode}`, {
        method: "POST",
        body:
          mode === "register"
            ? values
            : { email: values.email, password: values.password },
        skipRefresh: true,
      });
      setUser(user);
      router.replace("/dashboard");
    } catch (err) {
      setServerError(
        err instanceof ApiError ? err.message : "Something went wrong — try again",
      );
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}
        className="w-full max-w-md"
      >
        <div className="mb-8 flex items-center justify-center gap-2">
          <Clapperboard className="h-7 w-7 text-primary" />
          <span className="text-xl font-bold tracking-tight">ClipForge AI</span>
        </div>
        <Card className="p-8">
          <h1 className="mb-1 text-lg font-semibold">
            {mode === "login" ? "Welcome back" : "Create your account"}
          </h1>
          <p className="mb-6 text-sm text-muted">
            {mode === "login"
              ? "Sign in to continue to your projects."
              : "Turn long videos you own into polished short clips."}
          </p>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            {mode === "register" && (
              <div>
                <Label htmlFor="name">Name</Label>
                <Input id="name" placeholder="Your name" {...register("name")} />
                <FieldError message={errors.name?.message} />
              </div>
            )}
            <div>
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                placeholder="you@example.com"
                {...register("email")}
              />
              <FieldError message={errors.email?.message} />
            </div>
            <div>
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                placeholder="••••••••"
                {...register("password")}
              />
              <FieldError message={errors.password?.message} />
            </div>
            {serverError && (
              <p className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
                {serverError}
              </p>
            )}
            <Button type="submit" className="w-full" loading={isSubmitting}>
              {mode === "login" ? "Sign in" : "Create account"}
            </Button>
          </form>
          <p className="mt-6 text-center text-sm text-muted">
            {mode === "login" ? (
              <>
                New to ClipForge?{" "}
                <Link href="/register" className="text-primary hover:underline">
                  Create an account
                </Link>
              </>
            ) : (
              <>
                Already have an account?{" "}
                <Link href="/login" className="text-primary hover:underline">
                  Sign in
                </Link>
              </>
            )}
          </p>
        </Card>
      </motion.div>
    </div>
  );
}
