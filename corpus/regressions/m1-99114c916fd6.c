
int main(void) {
    int values[64];
    int n = 0;
    int target = 0;

    if (scanf("%d", &n) != 1 || n < 0 || n > 64) {
        return 1;
    }
    for (int i = 0; i < n; i++) {
        if (scanf("%d", &values[i]) != 1) {
            return 1;
        }
    }
    if (scanf("%d", &target) != 1) {
        return 1;
    }

    int i = 0;
    while (i < n && values[i] != target) {
        i++;
    }

    printf("%d\n", i < n ? i : -1);
    return 0;
}
