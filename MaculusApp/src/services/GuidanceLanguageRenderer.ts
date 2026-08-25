import { GuidanceDirective, SceneGroundingContext } from '../types';

export function renderDirective(directive: GuidanceDirective, targetName?: string): string {
  const target = targetName || 'The target';
  switch (directive.kind) {
    case 'stop_immediately': return 'Stop. The visible path is blocked.';
    case 'keep_left': return 'Keep slightly left.';
    case 'keep_right': return 'Keep slightly right.';
    case 'return_center': return 'Come back toward the center.';
    case 'continue_forward': return 'The path is clear again. Continue forward.';
    case 'target_left': return `${target} is to your left. Turn slowly toward it.`;
    case 'target_right': return `${target} is to your right. Turn slowly toward it.`;
    case 'target_ahead': return `${target} is ahead. Keep straight.`;
    case 'target_lost': return 'I lost sight of the target. Stop and turn slowly so I can find it again.';
    case 'check_with_hand': return `${target} is close ahead. Stop here and check with your hand.`;
  }
}

export function renderGroundedScene(context: SceneGroundingContext, focus?: string): string {
  if (!context.cameraAvailable) {
    return 'I cannot see the scene right now. Distance monitoring is still active if the sensor is available.';
  }
  const normalizedFocus = focus?.trim().toLowerCase();
  const focusTerms = (normalizedFocus?.match(/[a-z0-9]+/g) || [])
    .filter(term => !['a', 'an', 'the', 'is', 'are', 'what', 'on', 'near', 'around'].includes(term));
  const entityFacts = context.facts.filter(fact =>
    (fact.kind === 'entity' || fact.kind === 'relationship') && (
      focusTerms.length === 0 || focusTerms.some(term => fact.text.toLowerCase().includes(term))
    ),
  );
  const pathAhead = context.facts.find(fact => fact.id === 'path:ahead');
  const selected = entityFacts.slice(0, 4).map(fact => capitalize(fact.text));
  if (selected.length === 0) {
    selected.push(normalizedFocus
      ? `I cannot currently see ${normalizedFocus}`
      : 'I do not have any stable object detections to describe');
  }
  if (pathAhead) {selected.push(capitalize(pathAhead.text));}
  return `${selected.join('. ')}.`;
}

export function renderGreeting(context: SceneGroundingContext, date: Date = new Date()): string {
  const hour = date.getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  if (!context.cameraAvailable) {
    return `${greeting}. I’m ready, but I cannot see the scene right now. Distance monitoring remains active.`;
  }
  const center = context.pathZones.ahead.state;
  if (center === 'clear') {return `${greeting}. I’m ready. The center path looks clear.`;}
  if (center === 'blocked') {return `${greeting}. I’m ready. The path ahead appears blocked, so please wait for guidance.`;}
  return `${greeting}. I’m ready. Give me a moment to keep checking the path.`;
}

/**
 * Short acknowledgement lead-in spoken before descriptive guidance. The
 * dispatcher calls this with profile 'ack' so it carries a slightly higher
 * pitch and a 160 ms pre-delay.
 */
export function renderAck(kind: 'start' | 'acknowledge' | 'hold'): string {
  switch (kind) {
    case 'start': return 'Okay.';
    case 'acknowledge': return 'Got it.';
    case 'hold': return 'One moment.';
  }
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
