import { apiGet, apiPost, encodePathSegment } from './client.js';

export async function getSelf(): Promise<Record<string, unknown>> {
  return apiGet('/api/users/self');
}

export interface RatingUpdate {
  rating?: number;
  isFavorite?: boolean;
}

export async function updateUserRating(
  userId: string,
  slug: string,
  update: RatingUpdate,
): Promise<void> {
  await apiPost(`/api/users/${encodePathSegment(userId, 'user ID')}/ratings/${encodePathSegment(slug, 'slug')}`, update);
}

export async function getSelfRating(recipeId: string): Promise<Record<string, unknown>> {
  return apiGet(`/api/users/self/ratings/${encodePathSegment(recipeId, 'recipe ID')}`);
}
