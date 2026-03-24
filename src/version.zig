/// App version, embedded at build time from the VERSION file.
const raw = @embedFile("version");

pub const string: []const u8 = blk: {
    // Trim trailing whitespace/newlines at comptime
    var end: usize = raw.len;
    while (end > 0 and (raw[end - 1] == '\n' or raw[end - 1] == '\r' or raw[end - 1] == ' ')) {
        end -= 1;
    }
    break :blk raw[0..end];
};
