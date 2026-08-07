/**
 * Read-only source for the Dashboard's explicit sample sandbox.
 *
 * This snapshot is byte-checked against samples/05-insertion-sort/main.c by
 * tests/samples/insertion-sort-sandbox.test.ts. Creating the sandbox still
 * goes through the normal atomic workspace create request.
 */
export const INSERTION_SORT_SAMPLE_SOURCE = `#include <stdio.h>

int main(void) {
    int values[64];
    int n = 0;

    if (scanf("%d", &n) != 1 || n < 0 || n > 64) {
        return 1;
    }
    for (int i = 0; i < n; i++) {
        if (scanf("%d", &values[i]) != 1) {
            return 1;
        }
    }

    for (int i = 1; i < n; i++) {
        int key = values[i];
        int j = i - 1;
        while (j >= 0 && values[j] > key) {
            values[j + 1] = values[j];
            j--;
        }
        values[j + 1] = key;
    }

    for (int i = 0; i < n; i++) {
        printf("%s%d", i == 0 ? "" : " ", values[i]);
    }
    putchar('\\n');
    return 0;
}
`;
