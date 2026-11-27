export const origin = "https://writer.example.test";
export const service = "https://axis.example.test:8443";
export const series = {"id":"ser_00000000000a","owner_id":"usr_alice","title":"Ashfall","genre_rubric_id":null,"foundation":{}};
export const book = {"id":"bk_00000000000a","series_id":"ser_00000000000a","title":"The Third Bell","status":"drafting","ordinal":1,"author_id":"usr_alice","language":"English","label":null};
export const expectedTrace = [
  { path: "/series", status: 500, origin, body: { error: { code: "internal", message: "Internal error", details: null } } },
  { path: "/series", status: 200, origin, body: { series: [series] } },
  { path: "/series/" + series.id, status: 200, origin, body: { series, books: [book] } },
];
