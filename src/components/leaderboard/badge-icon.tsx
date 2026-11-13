import * as React from "react";
import {
  Anchor,
  Award,
  Briefcase,
  Crown,
  DollarSign,
  Flame,
  Gem,
  HeartPulse,
  Percent,
  Shield,
  Target,
  Tent,
  Trophy,
  Users,
  UsersRound,
  Zap,
} from "lucide-react";

const MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  anchor: Anchor,
  award: Award,
  briefcase: Briefcase,
  crown: Crown,
  "dollar-sign": DollarSign,
  flame: Flame,
  gem: Gem,
  "heart-pulse": HeartPulse,
  percent: Percent,
  shield: Shield,
  target: Target,
  tent: Tent,
  trophy: Trophy,
  users: Users,
  "users-round": UsersRound,
  zap: Zap,
};

export function BadgeIcon({ name, className }: { name: string; className?: string }) {
  const Icon = MAP[name] ?? Award;
  return <Icon className={className} />;
}
