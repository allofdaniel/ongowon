/**
 * 온고원 ONGOWON — Analytics Configuration (GA4 & Microsoft Clarity)
 *
 * GA4 측정 ID(G-XXXXXXX) 또는 Microsoft Clarity 프로젝트 ID가 준비되면
 * 아래 빈 문자열에 입력 후 커밋하거나, Vercel 환경변수
 * (GA4_MEASUREMENT_ID / CLARITY_PROJECT_ID)에 등록하면 전 페이지에 자동 적용됩니다.
 */
window.ONGOWON_ANALYTICS_CONFIG = {
  ga4Id: '',      // 예: 'G-XXXXXXXXXX'
  clarityId: '',  // 예: 'abcdefghij'
  endpoint: '/api/analytics/',
  debug: false,
};
