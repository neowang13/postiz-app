import {
  AuthTokenDetails,
  PostDetails,
  PostResponse,
  SocialProvider,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import { makeId } from '@gitroom/nestjs-libraries/services/make.is';
import dayjs from 'dayjs';
import {
  SocialAbstract,
  ValidityMedia,
} from '@gitroom/nestjs-libraries/integrations/social.abstract';
import { InstagramDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/instagram.dto';
import { InstagramProvider } from '@gitroom/nestjs-libraries/integrations/social/instagram.provider';
import { Integration } from '@prisma/client';
import { Rules } from '@gitroom/nestjs-libraries/chat/rules.description.decorator';

const instagramProvider = new InstagramProvider();

@Rules(
  "Instagram should have at least one attachment, if it's a story, it can have only one picture"
)
export class InstagramStandaloneProvider
  extends SocialAbstract
  implements SocialProvider
{
  identifier = 'instagram-standalone';
  name = 'Instagram\n(Standalone)';
  isBetweenSteps = false;
  refreshCron = true;
  scopes = [
    'instagram_business_basic',
    'instagram_business_content_publish',
    'instagram_business_manage_comments',
    'instagram_business_manage_messages',
    'instagram_business_manage_insights',
  ];
    override maxConcurrentJob = 200; // Instagram standalone has stricter limits
  dto = InstagramDto;

  editor = 'normal' as const;
  maxLength() {
    return 2200;
  }

  private async fetchOwnProfile(
    accessToken: string,
    fallbackId: string | number | undefined
  ) {
    const normalizedId = String(fallbackId || '').trim();
    const endpoints = [
      `https://graph.instagram.com/me?fields=id,user_id,username,name,profile_picture_url,account_type&access_token=${encodeURIComponent(
        accessToken
      )}`,
      normalizedId
        ? `https://graph.instagram.com/${encodeURIComponent(
            normalizedId
          )}?fields=id,user_id,username,name,profile_picture_url,account_type&access_token=${encodeURIComponent(
            accessToken
          )}`
        : '',
      normalizedId
        ? `https://graph.instagram.com/v21.0/${encodeURIComponent(
            normalizedId
          )}?fields=id,user_id,username,name,profile_picture_url,account_type&access_token=${encodeURIComponent(
            accessToken
          )}`
        : '',
    ].filter(Boolean);

    for (const endpoint of endpoints) {
      try {
        const response = await fetch(endpoint);
        const payload = await response.json().catch(() => null);
        if (!response.ok || !payload || payload.error) {
          continue;
        }

        return payload;
      } catch {
        continue;
      }
    }

    return null;
  }

  override async checkValidity(
    [firstPost]: Array<ValidityMedia[]>,
    settings: any
  ): Promise<string | true> {
    if (!firstPost?.length) {
      return 'Should have at least one media';
    }
    if (settings?.is_trial_reel) {
      if ((firstPost?.length ?? 0) > 1) {
        return 'Trial Reels can only have one video';
      }
      const hasVideo = firstPost?.some(
        (f) => (f?.path?.indexOf?.('mp4') ?? -1) > -1
      );
      if (!hasVideo) {
        return 'Trial Reels must be a video';
      }
    }
    return true;
  }

  public override handleErrors(
    body: string,
    status: number
  ):
    | { type: 'refresh-token' | 'bad-body' | 'retry'; value: string }
    | undefined {
    return instagramProvider.handleErrors(body, status);
  }

  async refreshToken(refresh_token: string): Promise<AuthTokenDetails> {
    const { access_token } = await (
      await fetch(
        `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${refresh_token}`
      )
    ).json();

    const profile = await this.fetchOwnProfile(access_token, undefined);
    const resolvedId = profile?.id || profile?.user_id || '';
    const username = profile?.username || '';
    const name = profile?.name || username || `Channel_${String(resolvedId).slice(0, 8)}`;
    const profilePictureUrl = profile?.profile_picture_url || '';

    return {
      id: resolvedId,
      name,
      accessToken: access_token,
      refreshToken: access_token,
      expiresIn: dayjs().add(58, 'days').unix() - dayjs().unix(),
      picture: profilePictureUrl,
      username,
    };
  }

  async generateAuthUrl() {
    const state = makeId(6);
    return {
      url:
        `https://www.instagram.com/oauth/authorize?enable_fb_login=0&client_id=${
          process.env.INSTAGRAM_APP_ID
        }&redirect_uri=${encodeURIComponent(
          `${
            process?.env.FRONTEND_URL?.indexOf('https') == -1
              ? `https://redirectmeto.com/${process?.env.FRONTEND_URL}`
              : `${process?.env.FRONTEND_URL}`
          }/integrations/social/instagram-standalone`
        )}&response_type=code&scope=${encodeURIComponent(
          this.scopes.join(',')
        )}` + `&state=${state}`,
      codeVerifier: makeId(10),
      state,
    };
  }

  async authenticate(params: {
    code: string;
    codeVerifier: string;
    refresh: string;
  }) {
    const formData = new FormData();
    formData.append('client_id', process.env.INSTAGRAM_APP_ID!);
    formData.append('client_secret', process.env.INSTAGRAM_APP_SECRET!);
    formData.append('grant_type', 'authorization_code');
    formData.append(
      'redirect_uri',
      `${
        process?.env.FRONTEND_URL?.indexOf('https') == -1
          ? `https://redirectmeto.com/${process?.env.FRONTEND_URL}`
          : `${process?.env.FRONTEND_URL}`
      }/integrations/social/instagram-standalone`
    );
    formData.append('code', params.code);

    const getAccessToken = await (
      await fetch('https://api.instagram.com/oauth/access_token', {
        method: 'POST',
        body: formData,
      })
    ).json();

    let longLivedAccessToken = '';
    try {
      const exchangeUrl = `https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${encodeURIComponent(
        process.env.INSTAGRAM_APP_SECRET!
      )}&access_token=${encodeURIComponent(getAccessToken.access_token)}`;
      const exchangeResponse = await fetch(exchangeUrl);
      const exchangePayload = await exchangeResponse.json().catch(() => null);
      if (exchangeResponse.ok && exchangePayload?.access_token) {
        longLivedAccessToken = exchangePayload.access_token;
      }
    } catch {
      longLivedAccessToken = '';
    }

    const accessToken = longLivedAccessToken || getAccessToken.access_token;

    this.checkScopes(this.scopes, getAccessToken.permissions);

    const profile = await this.fetchOwnProfile(
      accessToken,
      getAccessToken.user_id
    );
    const resolvedId =
      profile?.id || profile?.user_id || getAccessToken.user_id || '';
    const username = profile?.username || '';
    const name =
      profile?.name || username || `Channel_${String(resolvedId).slice(0, 8)}`;
    const profilePictureUrl = profile?.profile_picture_url || '';

    return {
      id: resolvedId,
      name,
      accessToken,
      refreshToken: accessToken,
      expiresIn: dayjs().add(58, 'days').unix() - dayjs().unix(),
      picture: profilePictureUrl,
      username,
    };
  }

  async post(
    id: string,
    accessToken: string,
    postDetails: PostDetails<InstagramDto>[],
    integration: Integration
  ): Promise<PostResponse[]> {
    return instagramProvider.post(
      id,
      accessToken,
      postDetails,
      integration,
      'graph.instagram.com'
    );
  }

  async comment(
    id: string,
    postId: string,
    lastCommentId: string | undefined,
    accessToken: string,
    postDetails: PostDetails<InstagramDto>[],
    integration: Integration
  ): Promise<PostResponse[]> {
    return instagramProvider.comment(
      id,
      postId,
      lastCommentId,
      accessToken,
      postDetails,
      integration,
      'graph.instagram.com'
    );
  }

  async analytics(id: string, accessToken: string, date: number) {
    return instagramProvider.analytics(
      id,
      accessToken,
      date,
      'graph.instagram.com'
    );
  }

  async postAnalytics(
    integrationId: string,
    accessToken: string,
    postId: string,
    date: number
  ) {
    return instagramProvider.postAnalytics(
      integrationId,
      accessToken,
      postId,
      date,
      'graph.instagram.com'
    );
  }
}
